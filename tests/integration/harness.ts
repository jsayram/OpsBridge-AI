import { exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { app } from "../../backend/src/app";
import { LOCAL_DOUBLE_AUDIENCE, LOCAL_DOUBLE_ISSUER } from "../../backend/src/auth/accessJwt";
import type { Bindings } from "../../backend/src/env";

export const ORIGIN = "http://localhost:8787";
const DB = process.env.OPSBRIDGE_TEST_DB ?? "opsbridge_test";
const url = (user: string) => `postgres://${user}:local_dev_only@127.0.0.1:54330/${DB}`;

export const connect = async (user: string) => {
  const c = new pg.Client({ connectionString: url(user) });
  await c.connect();
  return c;
};

type Limits = Partial<{
  ttl_seconds: number;
  workspace_cap: number;
  hourly_limit: number;
  reset_limit: number;
  write_cap: number;
}>;

// Limits are migrator-owned data, so tests change them the way a migration would.
export async function withLimits<T>(limits: Limits, fn: () => Promise<T>): Promise<T> {
  const mig = await connect("opsbridge_migrator");
  const { rows } = await mig.query("SELECT * FROM app.demo_limits");
  const before = rows[0];
  const set = async (l: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(l)) {
      if (k !== "id") await mig.query(`UPDATE app.demo_limits SET ${k} = $1`, [v]);
    }
  };
  await set(limits);
  try {
    return await fn();
  } finally {
    await set(before);
    await mig.end();
  }
}

export const OWNER_SUBJECT = "test-double-owner-subject";

// The test identity double: a throwaway key pair, regenerated every run, standing in for
// the provider. The private key never leaves this process.
const double = await generateKeyPair("RS256", { extractable: true });
const publicJwk = { ...(await exportJWK(double.publicKey)), kid: "double-1", alg: "RS256" };
export const doubleJwks = JSON.stringify({ keys: [publicJwk] });

type MintOptions = {
  sub?: string | null;
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: string | number;
  key?: CryptoKey;
};

export async function mintOwnerToken(options: MintOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "double-1" })
    .setIssuer(options.iss ?? LOCAL_DOUBLE_ISSUER)
    .setAudience(options.aud ?? LOCAL_DOUBLE_AUDIENCE)
    .setIssuedAt(options.iat ?? now)
    .setExpirationTime(options.exp ?? now + 300);
  if (options.sub !== null) jwt.setSubject(options.sub ?? OWNER_SUBJECT);
  return jwt.sign(options.key ?? double.privateKey);
}

export const ownerEnv: Partial<Bindings> = {
  OWNER_IDENTITY_MODE: "local-test-double",
  OWNER_SUBJECT_ALLOWLIST: OWNER_SUBJECT,
  OWNER_TEST_JWKS: doubleJwks,
};

export const baseEnv = (): Bindings => ({
  ASSETS: { fetch: async () => new Response("<!doctype html>spa", { status: 200 }) } as never,
  HYPERDRIVE: { connectionString: url("opsbridge_app") } as never,
  HYPERDRIVE_CLEANUP: { connectionString: url("opsbridge_cleanup") } as never,
  HYPERDRIVE_DISPATCH: { connectionString: url("opsbridge_dispatcher") } as never,
  ENVIRONMENT: "local",
  IP_HASH_KEY: "integration-test-key",
});

export type CallOptions = {
  method?: string;
  cookie?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  env?: Partial<Bindings>;
  origin?: string | null;
  base?: string;
};

export async function call(path: string, options: CallOptions = {}) {
  const method = options.method ?? (options.body !== undefined ? "POST" : "GET");
  const headers = new Headers(options.headers);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (!["GET", "HEAD"].includes(method) && options.origin !== null) {
    headers.set("origin", options.origin ?? options.base ?? ORIGIN);
  }
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  if (hasBody && !headers.has("content-type")) headers.set("content-type", "application/json");
  // Work handed to waitUntil (after-commit dispatch) finishes before the call returns, so a test
  // sees a settled state. A deployed Worker runs it after the response instead.
  const background: Promise<unknown>[] = [];
  const res = await app.fetch(
    new Request(`${options.base ?? ORIGIN}${path}`, {
      method,
      headers,
      ...(hasBody ? { body: options.rawBody ?? JSON.stringify(options.body) } : {}),
    }),
    { ...baseEnv(), ...options.env },
    {
      waitUntil(p: Promise<unknown>) {
        background.push(p);
      },
      passThroughOnException() {},
    } as never,
  );
  const text = await res.text();
  await Promise.allSettled(background);
  let json: Record<string, never> = {} as never;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON responses are checked through text */
  }
  return { status: res.status, headers: res.headers, json: json as any, text };
}

export const cookieFrom = (res: { headers: Headers }) => {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
};

export type Guest = { cookie: string; caseId: string; workspaceId: string };

// Launches a real session through the API and finds its first own case.
export async function launch(env?: Partial<Bindings>): Promise<Guest> {
  const res = await call("/api/v1/demo/sessions", { method: "POST", ...(env ? { env } : {}) });
  if (res.status !== 201) throw new Error(`launch failed ${res.status} ${res.text}`);
  const cookie = cookieFrom(res);
  const list = await call("/api/v1/cases?limit=1", { cookie });
  return { cookie, caseId: list.json.items[0].id, workspaceId: await workspaceOf(cookie) };
}

export const tokenHash = async (cookie: string) =>
  Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(cookie.slice(cookie.indexOf("=") + 1)),
    ),
  );

export async function workspaceOf(cookie: string): Promise<string> {
  const admin = await connect("opsbridge_migrator");
  const { rows } = await admin.query(
    "SELECT workspace_id FROM app.demo_sessions WHERE token_hash = $1",
    [await tokenHash(cookie)],
  );
  await admin.end();
  return rows[0].workspace_id;
}

let keyCounter = 0;
export const idempotencyKey = () => ({
  "idempotency-key": `test-key-${Date.now()}-${keyCounter++}`,
});

type PackCase = { id: string; version: number; status: string; pack_key: string };

// The three pack cases by key, read directly so a test can start from a known state.
export async function packCases(guest: Guest): Promise<Record<string, PackCase>> {
  const mig = await connect("opsbridge_migrator");
  const { rows } = await mig.query(
    "SELECT id, version, status, pack_key FROM app.cases WHERE workspace_id = $1 AND pack_key IS NOT NULL",
    [guest.workspaceId],
  );
  await mig.end();
  return Object.fromEntries(rows.map((r) => [r.pack_key, r]));
}

export const setRole = (cookie: string, role: string) =>
  call("/api/v1/demo/role", { method: "POST", cookie, body: { role } });

export async function counts(workspaceId: string, tables: string[]) {
  const mig = await connect("opsbridge_migrator");
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await mig.query(
      `SELECT count(*)::int AS n FROM app.${t} WHERE workspace_id = $1`,
      [workspaceId],
    );
    out[t] = rows[0].n;
  }
  await mig.end();
  return out;
}

export type Source = { id: string; provider: string; status: string; [k: string]: any };

export async function sources(cookie: string): Promise<Record<string, Source>> {
  const res = await call("/api/v1/integrations", { cookie });
  return Object.fromEntries(res.json.items.map((s: Source) => [s.provider, s]));
}

export const sync = (cookie: string, connectionId: string, body: Record<string, unknown> = {}) =>
  call(`/api/v1/integrations/${connectionId}/sync`, {
    method: "POST",
    cookie,
    headers: idempotencyKey(),
    body,
  });

export async function syncAll(cookie: string) {
  const list = await sources(cookie);
  const out = [];
  for (const provider of ["crm_simulator", "erp_simulator", "inventory_simulator"]) {
    out.push(await sync(cookie, (list[provider] as Source).id));
  }
  return out;
}

export async function findings(cookie: string, query = "limit=100") {
  const res = await call(`/api/v1/reconciliation?${query}`, { cookie });
  return res.json.items as any[];
}
