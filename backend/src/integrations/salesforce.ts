import type { Client, Db } from "../db";
import { inWorkspaceTx } from "../db";
import type { Bindings } from "../env";
import { ApiError, invalidRequest } from "../http/errors";
import type { CommandContext } from "../repo/records";
import { writeAudit } from "../repo/records";
import { crmAdapter } from "./adapters";
import { CRM_API_VERSION } from "./simulators";
import { open, seal } from "./tokenVault";
import { AdapterError, type SourceAdapter, type Transport } from "./types";

// The owner-only read connection (P3.3). Nothing here has met a real Salesforce org: it is built
// from Salesforce's public OAuth and REST documentation and tested against a labeled double.
// P3-D stays Pending Owner Credentials until Jose connects a Developer Edition org.
//
// Salesforce has no read-only OAuth scope. "api" allows writes, so read-only holds in two other
// places: this connector can only send GET to the data API, and docs/runbooks/CONNECTORS.md has
// the owner connect an integration user with read-only permissions.

export const SALESFORCE_SCOPES = ["api", "refresh_token"] as const;
const STATE_MINUTES = 10;
const OAUTH_TIMEOUT_MS = 8_000;
const SALESFORCE_HOST = /(^|\.)salesforce\.com$/;

export type SalesforceConfig = {
  loginUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  encryptionKey: string;
  transport: Transport;
  allowHost: (host: string) => boolean;
  double: boolean;
};

export function salesforceConfig(env: Bindings): SalesforceConfig | null {
  const {
    SALESFORCE_ENABLED: on,
    SALESFORCE_LOGIN_URL: loginUrl,
    SALESFORCE_CLIENT_ID: clientId,
    SALESFORCE_REDIRECT_URI: redirectUri,
    TOKEN_ENCRYPTION_KEY: encryptionKey,
  } = env;
  if (on !== "true" || !loginUrl || !clientId || !redirectUri || !encryptionKey) return null;
  const double =
    env.ENVIRONMENT === "local" && typeof env.SALESFORCE_TEST_DOUBLE === "function"
      ? env.SALESFORCE_TEST_DOUBLE
      : null;
  const allowHost = (host: string) =>
    double ? host.endsWith(".test-double.invalid") : SALESFORCE_HOST.test(host);
  let url: URL;
  try {
    url = new URL(loginUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !allowHost(url.hostname)) return null;
  return {
    loginUrl: url.origin,
    clientId,
    ...(env.SALESFORCE_CLIENT_SECRET ? { clientSecret: env.SALESFORCE_CLIENT_SECRET } : {}),
    redirectUri,
    encryptionKey,
    // A redirect is an error here: following one could carry a bearer token to another host.
    transport: double ?? ((req) => fetch(new Request(req, { redirect: "manual" }))),
    allowHost,
    double: double !== null,
  };
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const sha256 = async (text: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function beginAuthorize(ctx: CommandContext, config: SalesforceConfig) {
  const state = random(32);
  const verifier = random(48);
  const stateHash = await sha256(state);
  const sealed = await seal(config.encryptionKey, verifier, `oauth:${ctx.workspaceId}`);
  await ctx.db.query(
    `INSERT INTO app.oauth_states (workspace_id, state_hash, verifier_ciphertext, iv, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
    [
      ctx.workspaceId,
      Buffer.from(stateHash),
      Buffer.from(sealed.ciphertext),
      Buffer.from(sealed.iv),
      STATE_MINUTES,
    ],
  );
  const url = new URL(`${config.loginUrl}/services/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: SALESFORCE_SCOPES.join(" "),
    state,
    code_challenge: b64url(await sha256(verifier)),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

type TokenSet = { accessToken: string; refreshToken: string; instanceUrl: string };

const formPost = (config: SalesforceConfig, path: string, fields: Record<string, string>) =>
  config.transport(
    new Request(`${config.loginUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    }),
  );

const safeInstance = (config: SalesforceConfig, value: unknown) => {
  // A token goes only to an https Salesforce host, whatever a response claims.
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && config.allowHost(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
};

async function exchange(config: SalesforceConfig, fields: Record<string, string>) {
  const res = await formPost(config, "/services/oauth2/token", {
    client_id: config.clientId,
    ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    ...fields,
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok, body };
}

// `rotate` touches only a live row, so a refresh that finishes after a disconnect can't bring a
// scrubbed token back.
async function storeTokens(
  ctx: CommandContext,
  config: SalesforceConfig,
  secretId: string,
  tokens: TokenSet,
  rotate = false,
) {
  const sealed = await seal(
    config.encryptionKey,
    JSON.stringify(tokens),
    `token:${ctx.workspaceId}:${secretId}`,
  );
  await ctx.db.query(
    `UPDATE app.connection_secrets SET ciphertext = $3, iv = $4, scrubbed_at = NULL
      WHERE workspace_id = $1 AND id = $2 AND ($5 = false OR ciphertext IS NOT NULL)`,
    [ctx.workspaceId, secretId, Buffer.from(sealed.ciphertext), Buffer.from(sealed.iv), rotate],
  );
}

export async function completeAuthorize(
  client: Client,
  ctx: CommandContext,
  config: SalesforceConfig,
  input: { code: string; state: string },
) {
  // The state burns in its own commit, before the network call, so a failed exchange can't leave
  // it usable, and no transaction waits on the provider.
  const stateHash = Buffer.from(await sha256(input.state));
  const held = await inWorkspaceTx(client, ctx.workspaceId, async () => {
    const { rows } = await ctx.db.query(
      `UPDATE app.oauth_states SET consumed_at = now()
        WHERE workspace_id = $1 AND state_hash = $2 AND consumed_at IS NULL AND expires_at > now()
        RETURNING verifier_ciphertext, iv`,
      [ctx.workspaceId, stateHash],
    );
    return rows[0];
  });
  if (!held) throw invalidRequest("This sign-in link has expired. Start again.");
  const verifier = await open(
    config.encryptionKey,
    held.verifier_ciphertext,
    held.iv,
    `oauth:${ctx.workspaceId}`,
  );
  const { ok, body } = await exchange(config, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  }).catch(() => ({ ok: false, body: null as Record<string, unknown> | null }));
  const instanceUrl = safeInstance(config, body?.instance_url);
  if (
    !ok ||
    !instanceUrl ||
    typeof body?.access_token !== "string" ||
    typeof body.refresh_token !== "string"
  ) {
    throw new ApiError(502, "provider_rejected", "Salesforce didn't complete the connection.");
  }
  const tokens = { accessToken: body.access_token, refreshToken: body.refresh_token, instanceUrl };
  await inWorkspaceTx(client, ctx.workspaceId, async () => {
    const existing = (
      await ctx.db.query(
        "SELECT id, secret_reference FROM app.external_connections WHERE workspace_id = $1 AND provider = 'salesforce_test' FOR UPDATE",
        [ctx.workspaceId],
      )
    ).rows[0];
    const secretId: string =
      existing?.secret_reference ??
      (
        await ctx.db.query(
          `INSERT INTO app.connection_secrets (workspace_id, provider, scrubbed_at)
           VALUES ($1, 'salesforce_test', now()) RETURNING id`,
          [ctx.workspaceId],
        )
      ).rows[0].id;
    await storeTokens(ctx, config, secretId, tokens);
    await ctx.db.query(
      `INSERT INTO app.external_connections (workspace_id, provider, mode, status, scopes, secret_reference)
       VALUES ($1, 'salesforce_test', 'connected_test', 'Connected Test', $2, $3)
       ON CONFLICT (workspace_id, provider) DO UPDATE
         SET status = 'Connected Test', secret_reference = EXCLUDED.secret_reference, scopes = EXCLUDED.scopes,
             last_cursor = NULL, last_error_code = NULL, version = app.external_connections.version + 1`,
      [ctx.workspaceId, SALESFORCE_SCOPES, secretId],
    );
    await writeAudit(ctx, "connection.connected", "salesforce_test", {
      summary: config.double
        ? "Connected to the labeled test double"
        : "Connected to a Salesforce test org",
    });
  });
}

async function loadTokens(db: Db, config: SalesforceConfig, workspaceId: string, secretId: string) {
  const row = (
    await db.query(
      "SELECT ciphertext, iv FROM app.connection_secrets WHERE workspace_id = $1 AND id = $2",
      [workspaceId, secretId],
    )
  ).rows[0];
  if (!row?.ciphertext) return null;
  try {
    const plain = await open(
      config.encryptionKey,
      row.ciphertext,
      row.iv,
      `token:${workspaceId}:${secretId}`,
    );
    return JSON.parse(plain) as TokenSet;
  } catch {
    // A rotated or wrong key. Treated as no token, so a run fails cleanly and disconnect can scrub.
    return null;
  }
}

// Reads only. An expired access token gets one refresh, outside the retrying transport, so the
// timeout there can't abandon a refresh half way and spend the same refresh token twice. The
// rotated token is saved in its own short transaction before the read is repeated.
export function salesforceAdapter(
  client: Client,
  ctx: CommandContext,
  config: SalesforceConfig,
  secretId: string,
): SourceAdapter & { prepare(): Promise<void> } {
  let tokens: TokenSet | null = null;
  const refresh = async () => {
    const current = tokens as TokenSet;
    const { ok, body } = await exchange(config, {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
    }).catch(() => {
      throw new AdapterError("transient", "network_error");
    });
    if (!ok || typeof body?.access_token !== "string") {
      throw new AdapterError("auth", "token_revoked");
    }
    const next: TokenSet = {
      accessToken: body.access_token,
      refreshToken:
        typeof body.refresh_token === "string" ? body.refresh_token : current.refreshToken,
      instanceUrl: safeInstance(config, body.instance_url) ?? current.instanceUrl,
    };
    await inWorkspaceTx(client, ctx.workspaceId, () =>
      storeTokens(ctx, config, secretId, next, true),
    );
    tokens = next;
  };
  const transport: Transport = async (req) => {
    if (req.method !== "GET") throw new AdapterError("permission", "write_blocked");
    const headers = new Headers(req.headers);
    headers.set("authorization", `Bearer ${(tokens as TokenSet).accessToken}`);
    return config.transport(new Request(req, { headers }));
  };
  const inner = () =>
    crmAdapter(transport, {
      provider: "salesforce_test",
      mode: "connected_test",
      base: (tokens as TokenSet).instanceUrl,
      pageSize: 200,
    });
  const refreshOnce = async <T>(read: () => Promise<T>) => {
    try {
      return await read();
    } catch (e) {
      if (!(e instanceof AdapterError) || e.code !== "http_401") throw e;
      await refresh();
      return read();
    }
  };
  return {
    system: "crm",
    provider: "salesforce_test",
    mode: "connected_test",
    pageSize: 200,
    async prepare() {
      tokens = await inWorkspaceTx(client, ctx.workspaceId, () =>
        loadTokens(client, config, ctx.workspaceId, secretId),
      );
      if (!tokens) throw new AdapterError("auth", "token_unreadable");
    },
    list: (input) => refreshOnce(() => inner().list(input)),
    health: () => refreshOnce(() => inner().health()),
  };
}

// Revokes at the provider first, then scrubs here whatever the provider said, so a failed revoke
// can't leave a usable token in this database. The owner is told if the provider call failed.
export async function disconnect(
  client: Client,
  ctx: CommandContext,
  config: SalesforceConfig | null,
  connection: { id: string; secret_reference: string | null },
) {
  let providerRevoked = false;
  const tokens =
    config && connection.secret_reference
      ? await inWorkspaceTx(client, ctx.workspaceId, () =>
          loadTokens(client, config, ctx.workspaceId, connection.secret_reference as string),
        )
      : null;
  if (config && tokens) {
    const res = await formPost(config, "/services/oauth2/revoke", {
      token: tokens.refreshToken,
    }).catch(() => null);
    providerRevoked = res?.ok === true;
  }
  await inWorkspaceTx(client, ctx.workspaceId, async () => {
    await ctx.db.query(
      "SELECT 1 FROM app.external_connections WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
      [ctx.workspaceId, connection.id],
    );
    // A run in flight loses its lease here, so it can't write again or restore the status.
    await ctx.db.query(
      `UPDATE app.sync_runs
          SET status = 'dead_letter', error_class = 'auth', error_code = 'disconnected',
              ended_at = now(), lease_token = NULL
        WHERE workspace_id = $1 AND connection_id = $2 AND status = 'running'`,
      [ctx.workspaceId, connection.id],
    );
    await ctx.db.query(
      `UPDATE app.connection_secrets SET ciphertext = NULL, iv = NULL, scrubbed_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, connection.secret_reference],
    );
    await ctx.db.query(
      `UPDATE app.external_connections
          SET status = 'Disconnected', secret_reference = NULL, last_cursor = NULL, version = version + 1
        WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, connection.id],
    );
    await writeAudit(ctx, "connection.disconnected", "salesforce_test", {
      summary: providerRevoked
        ? "Token revoked at the provider and removed here"
        : "Token removed here; the provider revoke did not confirm",
    });
  });
  return { providerRevoked };
}

export const SALESFORCE_API_VERSION = CRM_API_VERSION;
