import type { Context } from "hono";
import { Hono } from "hono";
import { IDENTITY_LABEL } from "../auth/accessJwt";
import type { OwnerActor } from "../auth/actor";
import type { Client } from "../db";
import { inWorkspaceTx, withClient, withWorkspace } from "../db";
import type { AppEnv } from "../env";
import { ApiError, invalidRequest, notFound } from "../http/errors";
import { canonicalId } from "../http/validate";
import {
  beginAuthorize,
  completeAuthorize,
  disconnect,
  SALESFORCE_SCOPES,
  salesforceAdapter,
  salesforceConfig,
} from "../integrations/salesforce";
import { isScenario } from "../integrations/scenarios";
import { AdapterError } from "../integrations/types";
import { commandContext } from "../repo/records";
import { loadConnection } from "../repo/sync";
import { adapterForSimulated, resumeSync, runSync } from "./integrations";

// Everything here sits behind ownerGate, mounted in app.ts ahead of this router.
export const admin = new Hono<AppEnv>();

admin.get("/status", (c) => {
  const actor = c.get("actor") as OwnerActor;
  return c.json({
    ownerIdentity: IDENTITY_LABEL,
    identityMode: actor.identityMode,
    simulated: actor.identityMode === "local-test-double",
  });
});

// Server-side revocation. Provider sign-out is the browser's next step, at the URL below.
admin.post("/logout", async (c) => {
  const actor = c.get("actor") as OwnerActor;
  await withClient(c.env.HYPERDRIVE, (db) =>
    db.query("SELECT app.revoke_owner_sessions($1, $2)", [actor.subject, c.get("requestId")]),
  );
  return c.json({ signedOut: true, providerLogoutPath: "/cdn-cgi/access/logout" });
});

const notConfigured = () =>
  new ApiError(409, "not_configured", "Salesforce isn't configured. See the connector runbook.");

admin.get("/integrations/salesforce", async (c) => {
  const actor = c.get("actor") as OwnerActor;
  const config = salesforceConfig(c.env);
  const { rows } = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    db.query(
      "SELECT id, status, last_success_at FROM app.external_connections WHERE workspace_id = $1 AND provider = 'salesforce_test'",
      [actor.workspaceId],
    ),
  );
  const connection = rows[0];
  return c.json({
    label: "Salesforce test org",
    configured: config !== null,
    testDouble: config?.double ?? false,
    claim: config && !config.double ? "Owner test mode" : "Pending Owner Credentials",
    requestedScopes: SALESFORCE_SCOPES,
    connection: connection
      ? {
          id: connection.id,
          status: connection.status,
          lastSuccessAt: connection.last_success_at?.toISOString() ?? null,
        }
      : null,
  });
});

admin.post("/integrations/salesforce/authorize", async (c) => {
  const actor = c.get("actor") as OwnerActor;
  const config = salesforceConfig(c.env);
  if (!config) throw notConfigured();
  const authorizeUrl = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    beginAuthorize(commandContext(db, actor, c.get("requestId")), config),
  );
  return c.json({ authorizeUrl });
});

admin.get("/integrations/salesforce/callback", async (c) => {
  const actor = c.get("actor") as OwnerActor;
  const config = salesforceConfig(c.env);
  if (!config) throw notConfigured();
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state || code.length > 2000 || state.length > 200) {
    throw invalidRequest("The provider didn't complete the sign-in");
  }
  await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    completeAuthorize(commandContext(db, actor, c.get("requestId")), config, { code, state }),
  );
  return c.redirect("/admin");
});

const ownerAdapter = (c: Context<AppEnv>) => ({
  live: true,
  build: async (
    db: Client,
    connection: Record<string, unknown>,
    claimed: Record<string, unknown>,
  ) => {
    if (connection.mode === "simulated") {
      return adapterForSimulated(
        connection,
        isScenario(claimed.scenario) ? claimed.scenario : "baseline",
        claimed.resumes as number,
      );
    }
    const config = salesforceConfig(c.env);
    if (!config) throw new AdapterError("auth", "not_configured");
    const actor = c.get("actor") as OwnerActor;
    const ctx = commandContext(db, actor, c.get("requestId"));
    const secret = await inWorkspaceTx(db, actor.workspaceId, () =>
      db.query(
        "SELECT secret_reference FROM app.external_connections WHERE workspace_id = $1 AND id = $2",
        [actor.workspaceId, connection.id],
      ),
    );
    const secretId = secret.rows[0]?.secret_reference as string | null;
    if (!secretId) throw new AdapterError("auth", "token_missing");
    const adapter = salesforceAdapter(db, ctx, config, secretId);
    await adapter.prepare();
    return adapter;
  },
});

admin.post("/integrations/:id/sync", (c) => runSync(c, ownerAdapter(c)));
admin.post("/integrations/:id/runs/:runId/resume", (c) => resumeSync(c, ownerAdapter(c)));

admin.post("/integrations/:id/disconnect", async (c) => {
  const actor = c.get("actor") as OwnerActor;
  const id = canonicalId(c.req.param("id"));
  const config = salesforceConfig(c.env);
  if (!config) throw notConfigured();
  const out = await withClient(c.env.HYPERDRIVE, async (db) => {
    const ctx = commandContext(db, actor, c.get("requestId"));
    const row = await inWorkspaceTx(db, actor.workspaceId, async () => {
      const held = await loadConnection(db, actor.workspaceId, id);
      if (held.mode !== "connected_test") throw notFound();
      const { rows } = await db.query(
        "SELECT id, secret_reference FROM app.external_connections WHERE workspace_id = $1 AND id = $2",
        [actor.workspaceId, id],
      );
      return rows[0];
    });
    return disconnect(db, ctx, config, row);
  });
  return c.json(out);
});
