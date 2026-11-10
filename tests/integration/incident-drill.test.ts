// P7.3: the incident runbook (docs/runbooks/INCIDENT.md), rehearsed in order against the local
// stack. Each step is the switch the runbook names; providers are labeled doubles. One test,
// because the steps depend on each other the way a real response does.
import { afterAll, describe, expect, it } from "vitest";
import { modelDouble, textReply } from "./ai-double";
import {
  approvedEvent,
  dispatch,
  insertEvent,
  OWNER_WORKSPACE_ID as OWNER,
  outboxRow,
} from "./automation-helpers";
import { call, connect, idempotencyKey, launch, mintOwnerToken, ownerEnv } from "./harness";
import { doubleEnv, salesforceDouble } from "./salesforce-double";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

// If the drill fails midway, the emergency stop must not leak into later files.
afterAll(async () => {
  const mig = await connect("opsbridge_migrator");
  await mig.query("UPDATE app.automation_control SET dispatch_paused = false, reason = NULL");
  await mig.end();
});

describe("incident runbook rehearsal (P7.3)", () => {
  it("contain, revoke, rotate and recover, with nothing lost and every step audited", async () => {
    const sf = salesforceDouble();
    const env = { ...ownerEnv, ...doubleEnv(sf.fetchDouble) };
    const owner = async (path: string, opts: Record<string, unknown> = {}, token?: string) =>
      call(path, {
        env,
        ...opts,
        headers: {
          "cf-access-jwt-assertion": token ?? (await mintOwnerToken()),
          ...((opts.headers as Record<string, string>) ?? {}),
        },
      });
    const startedAt = new Date();

    // Before: a guest is working, the owner has Salesforce connected.
    const guest = await launch();
    expect((await call("/api/v1/cases", { cookie: guest.cookie })).status).toBe(200);
    const started = await owner("/api/v1/admin/integrations/salesforce/authorize", {
      method: "POST",
    });
    const state = new URL(started.json.authorizeUrl).searchParams.get("state");
    expect(
      (await owner(`/api/v1/admin/integrations/salesforce/callback?code=good-code&state=${state}`))
        .status,
    ).toBe(302);
    const connection = (await owner("/api/v1/admin/integrations/salesforce")).json.connection.id;

    // 2. Contain: pause launches. New visitors are refused; the working guest keeps reading.
    const paused = { DEMO_LAUNCH_PAUSED: "true" };
    const refused = await call("/api/v1/demo/sessions", { method: "POST", env: paused });
    expect(refused.status).toBe(503);
    expect(refused.json.error?.code ?? refused.json.code).toBe("demo_paused");
    expect((await call("/api/v1/cases", { cookie: guest.cookie, env: paused })).status).toBe(200);

    // 2. Contain: emergency stop. A new owner event waits; nothing is dispatched or dropped.
    const stop = await owner("/api/v1/admin/automations/pause", {
      body: { paused: true, reason: "incident drill" },
    });
    expect(stop.status).toBe(200);
    const held = await insertEvent(OWNER, "approval.completed", approvedEvent(), "owner");
    expect(await dispatch({ workspaceId: OWNER })).toEqual([]);
    expect((await outboxRow(OWNER, held)).dispatch_state).toBe("pending");

    // 2. Contain: live AI off by removing its settings. A live request gets the fixture.
    const doc = await owner(
      "/api/v1/cases/00000000-0000-4000-8000-000000000004/documents/from-fixture",
      {
        body: { fixtureId: "fx-standard-04" },
        headers: idempotencyKey(),
      },
    );
    expect(doc.status).toBe(201);
    const model = modelDouble(() => textReply("{}"));
    const { AI_LIVE_ENABLED: _off, ...aiWithoutSwitch } = model.env;
    const review = await call(`/api/v1/documents/${doc.json.id}/review`, {
      env: { ...env, ...aiWithoutSwitch },
      headers: { "cf-access-jwt-assertion": await mintOwnerToken() },
      body: { mode: "live" },
    });
    expect(review.status).toBe(201);
    expect(review.json.degraded).toBe("live_ai_disabled");
    expect(model.requests).toHaveLength(0);

    // 3. Revoke: Salesforce disconnect revokes at the provider and scrubs the stored token.
    expect(sf.state.revoked).toBe(false);
    expect(
      (await owner(`/api/v1/admin/integrations/${connection}/disconnect`, { method: "POST" }))
        .status,
    ).toBe(200);
    const mig = await connect("opsbridge_migrator");
    const secret = await mig.query(
      "SELECT count(*)::int AS live FROM app.connection_secrets WHERE workspace_id = $1 AND ciphertext IS NOT NULL",
      [OWNER],
    );
    expect(secret.rows[0].live).toBe(0);
    expect(sf.state.revoked).toBe(true);

    // 3. Rotate: every guest session ends at once. The old cookie is refused on its next request.
    await mig.query("UPDATE app.demo_sessions SET expires_at = now() WHERE expires_at > now()");
    expect((await call("/api/v1/cases", { cookie: guest.cookie })).status).toBe(401);

    // 3. Revoke: owner logout. A token issued before it is refused even inside its expiry.
    const oldToken = await mintOwnerToken({ iat: now() - 5 });
    expect((await owner("/api/v1/admin/logout", { method: "POST" }, oldToken)).status).toBe(200);
    expect((await owner("/api/v1/admin/status", {}, oldToken)).status).toBe(401);
    await sleep(1100);
    expect(
      (await owner("/api/v1/admin/status", {}, await mintOwnerToken({ iat: now() }))).status,
    ).toBe(200);

    // 4. Recover: resume dispatch; the held event goes out on the next pass, once.
    const resume = await owner("/api/v1/admin/automations/pause", {
      body: { paused: false, reason: "incident drill over" },
      headers: { "cf-access-jwt-assertion": await mintOwnerToken({ iat: now() }) },
    });
    expect(resume.status).toBe(200);
    const out = await dispatch({ workspaceId: OWNER, max: 10 });
    expect(out.map((o) => o.id)).toContain(held);
    expect((await outboxRow(OWNER, held)).dispatch_state).toBe("simulated");
    // Launches open again once the variable is removed.
    expect((await call("/api/v1/demo/sessions", { method: "POST" })).status).toBe(201);

    // 5. The record: each owner action is in the audit trail with its time.
    const { rows } = await mig.query(
      `SELECT action FROM app.audit_events WHERE workspace_id = $1 AND occurred_at >= $2
        AND action IN ('automation.paused','automation.resumed','connection.disconnected','owner.logout')
        ORDER BY occurred_at, action`,
      [OWNER, startedAt],
    );
    await mig.end();
    expect(rows.map((r) => r.action)).toEqual([
      "automation.paused",
      "connection.disconnected",
      "owner.logout",
      "automation.resumed",
    ]);
  });
});
