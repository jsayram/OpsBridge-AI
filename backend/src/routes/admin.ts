import type { Context } from "hono";
import { Hono } from "hono";
import { IDENTITY_LABEL } from "../auth/accessJwt";
import type { OwnerActor } from "../auth/actor";
import type { Client } from "../db";
import { inWorkspaceTx, withClient, withWorkspace } from "../db";
import type { AppEnv } from "../env";
import { ApiError, invalidRequest, notFound } from "../http/errors";
import { canonicalId, optionalText, readStrictJson, requireText } from "../http/validate";
import { dispatchDue } from "../jobs/dispatch";
import { sheetConfig } from "../integrations/sinks";
import { automationStatus, confirmRun, retryRun, setPause } from "../repo/automations";
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
import { adapterForSimulated, moveRun, runSync } from "./integrations";

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
    claim:
      config && !config.double && connection?.status === "Connected Test"
        ? "Owner test mode"
        : "Pending Owner Credentials",
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
  await withClient(c.env.HYPERDRIVE, (db) =>
    completeAuthorize(db, commandContext(db, actor, c.get("requestId")), config, { code, state }),
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
admin.post("/integrations/:id/runs/:runId/continue", (c) =>
  moveRun(c, "continue", ownerAdapter(c)),
);
admin.post("/integrations/:id/runs/:runId/resume", (c) => moveRun(c, "resume", ownerAdapter(c)));

admin.post("/integrations/:id/disconnect", async (c) => {
  const actor = c.get("actor") as OwnerActor;
  const id = canonicalId(c.req.param("id"));
  // Missing config skips the provider call. It must never stop the local scrub.
  const config = salesforceConfig(c.env);
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

// P4.3 and P4.4: the owner's automation controls. The Sheet bridge claim stays Pending Owner
// Credentials until a real sheet and Zap have run (DEC-008); the double never counts.
admin.get("/automations", async (c) => {
  const actor = c.get("actor") as OwnerActor;
  const config = sheetConfig(c.env);
  const status = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    automationStatus(db),
  );
  return c.json({
    ...status,
    sheetBridge: {
      configured: config !== null,
      testDouble: config?.double ?? false,
      claim: "Pending Owner Credentials",
    },
    zapier: { claim: "Pending Owner Configuration", webhook: "Disabled, needs separate approval" },
  });
});

admin.post("/automations/pause", async (c) => {
  const actor = c.get("actor") as OwnerActor;
  const body = await readStrictJson(c, ["paused", "reason"]);
  if (typeof body.paused !== "boolean") throw invalidRequest("Bad paused");
  const paused = body.paused;
  const reason = paused
    ? requireText(body.reason, "Reason", 300)
    : optionalText(body.reason, "Reason", 300);
  const out = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    setPause(commandContext(db, actor, c.get("requestId")), paused, reason ?? null),
  );
  return c.json(out);
});

admin.post("/automations/runs/:id/retry", async (c) => {
  const actor = c.get("actor") as OwnerActor;
  const id = canonicalId(c.req.param("id"));
  const out = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    retryRun(commandContext(db, actor, c.get("requestId")), id),
  );
  return c.json(out);
});

admin.post("/automations/runs/:id/confirm", async (c) => {
  const actor = c.get("actor") as OwnerActor;
  const id = canonicalId(c.req.param("id"));
  const body = await readStrictJson(c, ["evidenceRef"]);
  const evidenceRef = requireText(body.evidenceRef, "Evidence reference", 200);
  if (/[\s<>"'`]/.test(evidenceRef)) throw invalidRequest("Evidence reference must be one token");
  const out = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    confirmRun(commandContext(db, actor, c.get("requestId")), id, evidenceRef),
  );
  return c.json(out);
});

// Run one bounded dispatch pass for the owner's workspace now, instead of waiting for the sweep.
admin.post("/automations/dispatch", async (c) => {
  const actor = c.get("actor") as OwnerActor;
  const out = await dispatchDue(c.env, { workspaceId: actor.workspaceId });
  return c.json({ dispatched: out.length, items: out });
});
