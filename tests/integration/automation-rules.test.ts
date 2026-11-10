// P4.1: typed rules, the five triggers, reuse for a second fictional team (JOB-TEST-06) and the
// refusals that keep a rule from ever naming a destination (P4-D).
import { describe, expect, it } from "vitest";
import { effectsOf, eventsOf, insertEvent, drain } from "./automation-helpers";
import {
  call,
  connect,
  findings,
  type Guest,
  idempotencyKey,
  launch,
  packCases,
  setRole,
  sources,
  sync,
} from "./harness";

const manager = async () => {
  const g = await launch();
  await setRole(g.cookie, "manager");
  return g;
};
const rules = async (g: Guest) =>
  (await call("/api/v1/automations/rules", { cookie: g.cookie })).json;
const patchRule = (g: Guest, id: string, body: unknown) =>
  call(`/api/v1/automations/rules/${id}`, { method: "PATCH", cookie: g.cookie, body });
const reuse = (g: Guest, id: string, queue: unknown, headers = idempotencyKey()) =>
  call(`/api/v1/automations/rules/${id}/reuse`, {
    method: "POST",
    cookie: g.cookie,
    headers,
    body: { queue },
  });
const simulate = (g: Guest, type: string, data: unknown) =>
  call("/api/v1/automations/simulate", { method: "POST", cookie: g.cookie, body: { type, data } });

const approvalRule = async (g: Guest) =>
  (await rules(g)).items.find((r: any) => r.trigger === "approval.completed");

async function approveCase(g: Guest, queue: string) {
  const mig = await connect("opsbridge_migrator");
  const c = (await packCases(g))["case-3"] as { id: string };
  // Moves the pack's Ready case to the team under test, as a handoff would.
  await mig.query("UPDATE app.cases SET queue = $2 WHERE id = $1", [c.id, queue]);
  const row = await mig.query("SELECT version FROM app.cases WHERE id = $1", [c.id]);
  await mig.end();
  const detail = await call(`/api/v1/cases/${c.id}`, { cookie: g.cookie });
  return call(`/api/v1/approvals/${detail.json.approval.id}/decision`, {
    method: "POST",
    cookie: g.cookie,
    headers: idempotencyKey(),
    body: { decision: "approve", caseVersion: row.rows[0].version },
  });
}

describe("P4.1 the five triggers", () => {
  it("each allowlisted event type validates in the simulator and dispatches through the real path", async () => {
    const g = await manager();
    const samples: Record<string, Record<string, string>> = {
      "case.created": { queue: "Field Services", caseType: "Billing" },
      "case.needs_review": { queue: "Seasonal Staffing", reason: "returned" },
      "approval.completed": { queue: "Field Services", decision: "approved" },
      "reconciliation.resolved": { kind: "definition_conflict" },
      "integration.degraded": { provider: "erp_simulator" },
    };
    for (const [type, data] of Object.entries(samples)) {
      const res = await simulate(g, type, data);
      expect(res.status, type).toBe(200);
      expect(res.json.outcome).toMatch(/Simulated|No enabled rule/);
    }
    // approval.completed matches the seeded Field Services rule; case.needs_review the notice rule.
    expect(
      (await simulate(g, "approval.completed", samples["approval.completed"])).json.matched,
    ).toHaveLength(1);
    expect(
      (await simulate(g, "case.needs_review", samples["case.needs_review"])).json.matched,
    ).toHaveLength(1);
    expect((await simulate(g, "made.up", {})).status).toBe(400);

    // Real commands for every type, each dispatched right after its commit.
    const customers = await call("/api/v1/customers", { cookie: g.cookie });
    const created = await call("/api/v1/cases", {
      method: "POST",
      cookie: g.cookie,
      headers: idempotencyKey(),
      body: {
        title: "P4 trigger check",
        customerId: customers.json.items[0].id,
        caseType: "Billing",
      },
    });
    expect(created.status).toBe(201);
    expect((await approveCase(g, "Field Services")).status).toBe(200);
    // A rejection returns the case for review: approval.completed plus case.needs_review.
    const r = await manager();
    const ready = (await packCases(r))["case-3"] as { id: string; version: number };
    const detail = await call(`/api/v1/cases/${ready.id}`, { cookie: r.cookie });
    const rejected = await call(`/api/v1/approvals/${detail.json.approval.id}/decision`, {
      method: "POST",
      cookie: r.cookie,
      headers: idempotencyKey(),
      body: { decision: "reject", caseVersion: ready.version, reason: "Missing scope" },
    });
    expect(rejected.status).toBe(200);
    const review = await eventsOf(r.workspaceId, "case.needs_review");
    expect(review).toHaveLength(1);
    expect(review[0].dispatch_state).toBe("simulated");
    // The seeded notice rule matches every needs_review event.
    expect(await effectsOf(r.workspaceId, review[0].id)).toHaveLength(1);
    const conflict = (await findings(g.cookie)).find((f) => f.kind === "definition_conflict");
    const a = await call(`/api/v1/reconciliation/${conflict.id}/advance`, {
      method: "POST",
      cookie: g.cookie,
      body: { to: "Investigating", version: conflict.version },
    });
    const b = await call(`/api/v1/reconciliation/${conflict.id}/advance`, {
      method: "POST",
      cookie: g.cookie,
      body: { to: "Proposed", version: a.json.version, proposal: "Reviewed." },
    });
    expect(
      (
        await call(`/api/v1/reconciliation/${conflict.id}/resolve`, {
          method: "POST",
          cookie: g.cookie,
          headers: idempotencyKey(),
          body: { version: b.json.version, decision: "approve" },
        })
      ).status,
    ).toBe(200);
    const list = await sources(g.cookie);
    await sync(g.cookie, list.erp_simulator?.id as string, { scenario: "http_5xx_outage" });

    const events = await eventsOf(g.workspaceId);
    const types = new Set(events.map((e) => e.event_type));
    for (const t of [
      "case.created",
      "approval.completed",
      "reconciliation.resolved",
      "integration.degraded",
    ]) {
      expect(types.has(t), t).toBe(true);
    }
    // Every event settled as Simulated: a demo workspace has no other sink.
    for (const e of events) {
      expect(e.dispatch_state, e.event_type).toBe("simulated");
      expect(e.attempts).toBe(1);
    }
    const approved = events.find((e) => e.event_type === "approval.completed");
    expect((await effectsOf(g.workspaceId, approved.id)).map((x) => x.sink)).toEqual(["simulated"]);
  });
});

describe("P4.1 JOB-TEST-06: one typed rule reused by a second fictional team", () => {
  it("reuses the rule without copying logic, scopes each team, and stays in its workspace", async () => {
    const g = await manager();
    const other = await manager();
    const source = await approvalRule(g);
    expect(source.condition).toEqual({ queue: "Field Services", decision: "approved" });
    expect(source.reusable).toBe(true);

    const headers = idempotencyKey();
    const made = await reuse(g, source.id, "Seasonal Staffing", headers);
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({
      trigger: source.trigger,
      action: source.action,
      condition: { queue: "Seasonal Staffing", decision: "approved" },
      reusedFrom: source.id,
      version: 1,
    });
    // Same key replays the answer; a new key for the same team is refused, not duplicated.
    const replay = await reuse(g, source.id, "Seasonal Staffing", headers);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(replay.json.id).toBe(made.json.id);
    expect((await reuse(g, source.id, "Seasonal Staffing")).json.code).toBe("already_reused");
    expect((await reuse(g, source.id, "Field Services")).json.code).toBe("same_team");
    expect((await reuse(g, made.json.id, "Field Services")).json.code).toBe("reuse_of_reuse");

    // A Seasonal Staffing approval matches only the reused rule.
    expect((await approveCase(g, "Seasonal Staffing")).status).toBe(200);
    const [event] = await eventsOf(g.workspaceId, "approval.completed");
    expect(event.payload.data.queue).toBe("Seasonal Staffing");
    expect(event.dispatch_state).toBe("simulated");
    const effects = await effectsOf(g.workspaceId, event.id);
    expect(effects.map((e) => e.rule_id)).toEqual([made.json.id]);

    // The other workspace is untouched: no reused rule, no effects from here.
    expect((await rules(other)).items.some((r: any) => r.reusedFrom)).toBe(false);
    expect(await effectsOf(other.workspaceId, event.id)).toEqual([]);
    // And the same evaluator still serves Field Services through the original rule.
    const fs = await manager();
    await reuse(fs, (await approvalRule(fs)).id, "Seasonal Staffing");
    expect((await approveCase(fs, "Field Services")).status).toBe(200);
    const [fsEvent] = await eventsOf(fs.workspaceId, "approval.completed");
    const fsEffects = await effectsOf(fs.workspaceId, fsEvent.id);
    expect(fsEffects).toHaveLength(1);
    expect(fsEffects[0].rule_id).toBe((await approvalRule(fs)).id);
  });

  it("a reused rule and its source keep their teams, so two rules can't serve one team (review M2)", async () => {
    const g = await manager();
    const source = await approvalRule(g);
    const copy = (await reuse(g, source.id, "Seasonal Staffing")).json;
    const back = await patchRule(g, copy.id, {
      version: copy.version,
      condition: { queue: "Field Services", decision: "approved" },
    });
    expect(back.json.code).toBe("team_locked");
    expect((await patchRule(g, copy.id, { version: copy.version, condition: {} })).json.code).toBe(
      "team_locked",
    );
    expect(
      (
        await patchRule(g, source.id, {
          version: source.version,
          condition: { queue: "Seasonal Staffing" },
        })
      ).json.code,
    ).toBe("team_locked");
    // Narrowing without touching the team is still allowed.
    const narrowed = await patchRule(g, copy.id, {
      version: copy.version,
      condition: { queue: "Seasonal Staffing" },
    });
    expect(narrowed.status).toBe(200);
    expect((await approveCase(g, "Field Services")).status).toBe(200);
    const [event] = await eventsOf(g.workspaceId, "approval.completed");
    expect((await effectsOf(g.workspaceId, event.id)).map((e) => e.rule_id)).toEqual([source.id]);
  });

  it("a disabled rule produces no effect, and the version it ran under is recorded", async () => {
    const g = await manager();
    const rule = await approvalRule(g);
    const off = await patchRule(g, rule.id, { version: rule.version, enabled: false });
    expect(off.status).toBe(200);
    expect(off.json.version).toBe(rule.version + 1);
    expect((await patchRule(g, rule.id, { version: rule.version, enabled: true })).json.code).toBe(
      "stale_version",
    );
    expect((await approveCase(g, "Field Services")).status).toBe(200);
    const [event] = await eventsOf(g.workspaceId, "approval.completed");
    expect(event.dispatch_state).toBe("simulated");
    expect(event.evidence_ref).toBe("no-matching-rule");
    expect(await effectsOf(g.workspaceId, event.id)).toEqual([]);
    const on = await patchRule(g, rule.id, { version: off.json.version, enabled: true });
    const id = await insertEvent(g.workspaceId, "approval.completed", {
      caseRef: "CASE-0000AAAA",
      decision: "approved",
      queue: "Field Services",
    });
    await drain(g.workspaceId);
    expect((await effectsOf(g.workspaceId, id))[0].rule_version).toBe(on.json.version);
  });
});

describe("P4.1 and P4-D refusals: no URL, recipient or code anywhere in a rule", () => {
  it("rejects every attempt to put a destination, address or expression into a rule", async () => {
    const g = await manager();
    const rule = await approvalRule(g);
    const bad: unknown[] = [
      { queue: "https://attacker.example/hook" },
      { url: "https://attacker.example/hook" },
      { recipient: "someone@example.com" },
      { email: "someone@example.com" },
      { webhook: "https://hooks.zapier.com/hooks/catch/1/abc" },
      { queue: { $ne: "x" } },
      { queue: ["Field Services"] },
      { decision: "approved; DROP TABLE app.outbox" },
      { script: "fetch('https://x')" },
      { queue: "Field Services", decision: "approved", extra: "1" },
      "queue == 'Field Services'",
      ["queue"],
    ];
    for (const condition of bad) {
      const res = await patchRule(g, rule.id, { version: rule.version, condition });
      expect(res.status, JSON.stringify(condition)).toBe(400);
    }
    const proto = await call(`/api/v1/automations/rules/${rule.id}`, {
      method: "PATCH",
      cookie: g.cookie,
      rawBody: `{"version":${rule.version},"condition":{"__proto__":{"queue":"x"},"constructor":"y"}}`,
    });
    expect(proto.status).toBe(400);
    for (const field of ["destination", "url", "recipient", "action", "trigger", "code"]) {
      const res = await patchRule(g, rule.id, { version: rule.version, [field]: "x" });
      expect(res.status, field).toBe(400);
    }
    expect((await reuse(g, rule.id, "https://attacker.example")).status).toBe(400);
    expect((await reuse(g, rule.id, "Field Services <a@b.c>")).status).toBe(400);
    expect((await simulate(g, "approval.completed", { url: "https://x" })).status).toBe(400);
    // Nothing changed.
    expect((await approvalRule(g)).version).toBe(rule.version);
  });

  it("the rule table has no column that could hold a destination, and the database refuses unknown actions", async () => {
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'workflow_rules'",
    );
    const cols = rows.map((r) => r.column_name);
    for (const c of cols)
      expect(c).not.toMatch(/url|recipient|destination|email|webhook|address|target|code|script/);
    const ws = (await mig.query("SELECT id FROM app.workspaces WHERE mode = 'owner'")).rows[0].id;
    await expect(
      mig.query(
        "INSERT INTO app.workflow_rules (workspace_id, name, trigger_event, action) VALUES ($1, 'x', 'approval.completed', 'webhook')",
        [ws],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      mig.query(
        "INSERT INTO app.workflow_rules (workspace_id, name, trigger_event, action, condition) VALUES ($1, 'x', 'approval.completed', 'simulated_notice', '[1]')",
        [ws],
      ),
    ).rejects.toThrow(/check constraint/);
    await mig.end();
  });

  it("viewers and analysts can read rules but not change them; nobody reaches another workspace's rule", async () => {
    const g = await launch();
    const other = await manager();
    const rule = await approvalRule(g);
    expect((await patchRule(g, rule.id, { version: rule.version, enabled: false })).status).toBe(
      403,
    );
    await setRole(g.cookie, "analyst");
    expect((await patchRule(g, rule.id, { version: rule.version, enabled: false })).status).toBe(
      403,
    );
    expect((await reuse(g, rule.id, "Seasonal Staffing")).status).toBe(403);
    // A manager in another workspace gets a 404 for this rule's ID.
    expect(
      (await patchRule(other, rule.id, { version: rule.version, enabled: false })).status,
    ).toBe(404);
    expect((await reuse(other, rule.id, "Seasonal Staffing")).status).toBe(404);
    // Template rules are never editable.
    const mig = await connect("opsbridge_migrator");
    const tpl = (
      await mig.query(
        "SELECT r.id FROM app.workflow_rules r JOIN app.workspaces w ON w.id = r.workspace_id WHERE w.mode = 'template' LIMIT 1",
      )
    ).rows[0].id;
    await mig.end();
    expect((await patchRule(other, tpl, { version: 1, enabled: false })).status).toBe(404);
  });
});
