import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  call,
  connect,
  counts,
  type Guest,
  idempotencyKey,
  launch,
  packCases,
  setRole,
} from "./harness";

const EFFECT_TABLES = ["approvals", "audit_events", "outbox", "idempotency_keys"];

async function readyCase() {
  const g = await launch();
  await setRole(g.cookie, "manager");
  const c = (await packCases(g))["case-3"];
  const id = c?.id as string;
  const detail = await call(`/api/v1/cases/${id}`, { cookie: g.cookie });
  return { g, id, approvalId: detail.json.approval.id as string };
}

const decide = (
  g: Guest,
  approvalId: string,
  body: unknown,
  headers: Record<string, string> = idempotencyKey(),
) =>
  call(`/api/v1/approvals/${approvalId}/decision`, {
    method: "POST",
    cookie: g.cookie,
    headers,
    body,
  });

const state = async (g: Guest, id: string, approvalId: string): Promise<Record<string, any>> => {
  const mig = await connect("opsbridge_migrator");
  const c = await mig.query("SELECT status, version FROM app.cases WHERE id = $1", [id]);
  const a = await mig.query(
    "SELECT status, actor_id, decided_at FROM app.approvals WHERE id = $1",
    [approvalId],
  );
  await mig.end();
  return {
    case: c.rows[0],
    approval: a.rows[0],
    ...(await counts(g.workspaceId, EFFECT_TABLES)),
  };
};

// Fires inside the real command. Nothing in the application knows about it.
async function withFailure(table: string, when: string, fn: () => Promise<void>) {
  const mig = await connect("opsbridge_migrator");
  await mig.query(`CREATE OR REPLACE FUNCTION app.inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
  await mig.query(
    `CREATE TRIGGER inject_failure ${when} ON app.${table} FOR EACH ROW EXECUTE FUNCTION app.inject_failure()`,
  );
  try {
    await fn();
  } finally {
    await mig.query(`DROP TRIGGER inject_failure ON app.${table}`);
    await mig.query("DROP FUNCTION app.inject_failure()");
    await mig.end();
  }
}

describe("P2.4 atomic approval", () => {
  it("approve commits the decision, state, audit and outbox as one", async () => {
    const { g, id, approvalId } = await readyCase();
    const before = await counts(g.workspaceId, EFFECT_TABLES);
    const res = await decide(g, approvalId, { decision: "approve", caseVersion: 1 });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("approved");
    expect(res.json.case).toMatchObject({ status: "Approved", version: 2 });
    const after = await state(g, id, approvalId);
    expect(after.case).toEqual({ status: "Approved", version: 2 });
    expect(after.approval.status).toBe("approved");
    expect(after.approval.actor_id).toBeTruthy();
    expect(after.audit_events).toBe((before.audit_events ?? 0) + 1);
    expect(after.outbox).toBe((before.outbox ?? 0) + 1);
  });

  it("the outbox row matches the published envelope schema and stays Pending for P4", async () => {
    const { g, approvalId } = await readyCase();
    const res = await decide(g, approvalId, { decision: "approve", caseVersion: 1 });
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT * FROM app.outbox WHERE workspace_id = $1 AND idempotency_key = $2",
      [g.workspaceId, `approval:${approvalId}`],
    );
    await mig.end();
    const row = rows[0];
    expect(row).toMatchObject({
      event_type: "approval.completed",
      dispatch_state: "pending",
      delivery_evidence: "none",
      attempts: 0,
    });
    const schema = JSON.parse(readFileSync("docs/design/event-envelope.schema.json", "utf8"));
    const p = row.payload;
    expect(Object.keys(p).sort()).toEqual([...schema.required].sort());
    expect(p).toMatchObject({
      id: row.id,
      type: "approval.completed",
      version: 1,
      workspaceMode: "demo",
      requestId: res.headers.get("x-request-id"),
      data: { decision: "approved" },
    });
    expect(p.data.caseRef).toMatch(/^CASE-[0-9A-F]{8}$/);
    expect(row.payload_ref).toBe(p.data.caseRef);
    expect(Object.keys(p.data).sort()).toEqual(["caseRef", "decision"]);
    expect(JSON.stringify(p)).not.toContain(res.json.case.id);
  });

  it("ADR proof 2 repeat: 20 concurrent decisions, 30 rounds, one winner and one effect each", async () => {
    let clean = 0;
    for (let round = 0; round < 30; round++) {
      const { g, id, approvalId } = await readyCase();
      const before = await counts(g.workspaceId, EFFECT_TABLES);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          decide(g, approvalId, { decision: "approve", caseVersion: 1 }),
        ),
      );
      const winners = results.filter((r) => r.status === 200);
      const typed = results.filter(
        (r) => r.status === 409 && ["already_decided", "stale_version"].includes(r.json.code),
      );
      const after = await state(g, id, approvalId);
      if (
        winners.length === 1 &&
        typed.length === 19 &&
        after.case.status === "Approved" &&
        after.case.version === 2 &&
        after.audit_events === (before.audit_events ?? 0) + 1 &&
        after.outbox === (before.outbox ?? 0) + 1
      ) {
        clean++;
      }
    }
    expect(clean).toBe(30);
  }, 120_000);

  it("E2E-06 approve racing reject: one decision stands and the other gets a safe conflict", async () => {
    const { g, id, approvalId } = await readyCase();
    const [a, b] = await Promise.all([
      decide(g, approvalId, { decision: "approve", caseVersion: 1 }),
      decide(g, approvalId, { decision: "reject", caseVersion: 1, reason: "Not yet" }),
    ]);
    expect([a?.status, b?.status].sort()).toEqual([200, 409]);
    const after = await state(g, id, approvalId);
    expect(after.case.version).toBe(2);
    expect(["Approved", "Needs Review"]).toContain(after.case.status);
  });

  it("the same key concurrently gives one effect and the same answer", async () => {
    const { g, approvalId } = await readyCase();
    const before = await counts(g.workspaceId, ["audit_events", "outbox"]);
    const headers = idempotencyKey();
    const body = { decision: "approve", caseVersion: 1 };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => decide(g, approvalId, body, headers)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) expect(r.json).toEqual(results[0]?.json);
    expect(results.filter((r) => r.headers.get("idempotency-replayed")).length).toBe(4);
    const after = await counts(g.workspaceId, ["audit_events", "outbox"]);
    expect(after.audit_events).toBe((before.audit_events ?? 0) + 1);
    expect(after.outbox).toBe((before.outbox ?? 0) + 1);
  });

  it("a stale case version rolls back the approval too", async () => {
    const { g, id, approvalId } = await readyCase();
    const before = await state(g, id, approvalId);
    const res = await decide(g, approvalId, { decision: "approve", caseVersion: 9 });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("stale_version");
    expect(await state(g, id, approvalId)).toEqual(before);
  });

  it.each([
    ["outbox", "BEFORE INSERT", "the last insert"],
    ["audit_events", "BEFORE INSERT", "the audit insert"],
    ["cases", "AFTER UPDATE", "just after the state update"],
    ["idempotency_keys", "BEFORE UPDATE", "the final response write"],
  ])("injected failure at %s (%s, %s) leaves nothing behind", async (table, when) => {
    const { g, id, approvalId } = await readyCase();
    const before = await state(g, id, approvalId);
    let status = 0;
    await withFailure(table, when, async () => {
      status = (await decide(g, approvalId, { decision: "approve", caseVersion: 1 })).status;
    });
    expect(status).toBe(500);
    expect(await state(g, id, approvalId)).toEqual(before);
    const retry = await decide(g, approvalId, { decision: "approve", caseVersion: 1 });
    expect(retry.status).toBe(200);
  });

  it("reject needs a reason, returns the case, and a later entry to Ready is a new approval", async () => {
    const { g, id, approvalId } = await readyCase();
    const noReason = await decide(g, approvalId, { decision: "reject", caseVersion: 1 });
    expect(noReason.status).toBe(400);
    const res = await decide(g, approvalId, {
      decision: "reject",
      caseVersion: 1,
      reason: "Signature missing",
    });
    expect(res.status).toBe(200);
    expect(res.json.case.status).toBe("Needs Review");
    const again = await call(`/api/v1/cases/${id}`, {
      method: "PATCH",
      cookie: g.cookie,
      body: { status: "Ready", version: 2 },
    });
    expect(again.status).toBe(200);
    const detail = await call(`/api/v1/cases/${id}`, { cookie: g.cookie });
    expect(detail.json.approval.id).not.toBe(approvalId);
    const second = await decide(g, detail.json.approval.id, {
      decision: "approve",
      caseVersion: 3,
    });
    expect(second.status).toBe(200);
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT event_type, count(*)::int AS n FROM app.outbox WHERE workspace_id = $1 GROUP BY 1 ORDER BY 1",
      [g.workspaceId],
    );
    await mig.end();
    expect(rows).toEqual([
      { event_type: "approval.completed", n: 2 },
      { event_type: "case.needs_review", n: 1 },
    ]);
  });

  it("deciding twice with different keys is a typed conflict", async () => {
    const { g, approvalId } = await readyCase();
    await decide(g, approvalId, { decision: "approve", caseVersion: 1 });
    const again = await decide(g, approvalId, { decision: "approve", caseVersion: 2 });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("already_decided");
  });

  it("analyst and viewer are denied, and another workspace's approval is a 404", async () => {
    const { g, approvalId } = await readyCase();
    await setRole(g.cookie, "analyst");
    expect((await decide(g, approvalId, { decision: "approve", caseVersion: 1 })).status).toBe(403);
    await setRole(g.cookie, "viewer");
    expect((await decide(g, approvalId, { decision: "approve", caseVersion: 1 })).status).toBe(403);
    const other = await launch();
    await setRole(other.cookie, "manager");
    const res = await decide(other, approvalId, { decision: "approve", caseVersion: 1 });
    expect(res.status).toBe(404);
  });

  it("a shared template approval can't be decided", async () => {
    const g = await launch();
    await setRole(g.cookie, "manager");
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      `SELECT a.id FROM app.approvals a JOIN app.workspaces w ON w.id = a.workspace_id
        WHERE w.mode = 'template' LIMIT 1`,
    );
    const res = await decide(g, rows[0].id, { decision: "approve", caseVersion: 1 });
    expect(res.status).toBe(404);
    const after = await mig.query("SELECT status FROM app.approvals WHERE id = $1", [rows[0].id]);
    await mig.end();
    expect(after.rows[0].status).toBe("pending");
  });

  it("an uppercase approval ID gets the one event key", async () => {
    const { g, approvalId } = await readyCase();
    const res = await decide(g, approvalId.toUpperCase(), { decision: "approve", caseVersion: 1 });
    expect(res.status).toBe(200);
    const mig = await connect("opsbridge_migrator");
    const { rowCount } = await mig.query(
      "SELECT 1 FROM app.outbox WHERE workspace_id = $1 AND idempotency_key = $2",
      [g.workspaceId, `approval:${approvalId}`],
    );
    await mig.end();
    expect(rowCount).toBe(1);
  });

  it("refuses unknown fields, a bad decision and a missing key", async () => {
    const { g, approvalId } = await readyCase();
    const base = { decision: "approve", caseVersion: 1 };
    expect((await decide(g, approvalId, { ...base, actorId: "someone" })).status).toBe(400);
    expect((await decide(g, approvalId, { ...base, decision: "maybe" })).status).toBe(400);
    expect((await decide(g, approvalId, { decision: "approve" })).status).toBe(400);
    expect((await decide(g, approvalId, base, {})).status).toBe(400);
    expect((await decide(g, "not-a-uuid", base)).status).toBe(404);
  });
});
