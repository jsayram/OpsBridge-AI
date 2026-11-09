// P4.4 delivery labels and operator controls, and the P4.5 fault rehearsal across the whole path:
// owner approval -> business transaction -> after-commit dispatch -> Sheets double.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetSheetToken } from "../../backend/src/integrations/sinks";
import {
  approvedEvent,
  attemptsOf,
  dispatch,
  drain,
  effectsOf,
  eventsOf,
  guestDecide,
  insertEvent,
  makeDue,
  OWNER_WORKSPACE_ID as OWNER,
  outboxRow,
  ownerCall,
  ownerReadyCase,
  setPaused,
} from "./automation-helpers";
import {
  call,
  connect,
  counts,
  idempotencyKey,
  launch,
  mintOwnerToken,
  ownerEnv,
  packCases,
  setRole,
} from "./harness";
import { type SheetsDouble, sheetsDouble } from "./sheets-double";

let dbl: SheetsDouble;
beforeEach(async () => {
  dbl = await sheetsDouble();
  forgetSheetToken();
  await drain(OWNER);
});
afterEach(() => setPaused(false));

const run = async (id: string) => (await ownerCall(`/api/v1/automations/runs/${id}`)).json;
async function auditCount(action: string, target: string) {
  const mig = await connect("opsbridge_migrator");
  const { rows } = await mig.query(
    "SELECT count(*)::int AS n FROM app.audit_events WHERE action = $1 AND target = $2",
    [action, target],
  );
  await mig.end();
  return rows[0].n as number;
}

describe("P4.4 delivery labels never overclaim", () => {
  it("a provider 200 is Accepted with uncertainty, never Confirmed or Delivered", async () => {
    const id = await insertEvent(OWNER, "approval.completed", approvedEvent(), "owner");
    dbl.faults.push({ op: "append", fault: "ok_without_range" });
    await dispatch({ workspaceId: OWNER }, dbl);
    const r = await run(id);
    expect(r).toMatchObject({
      label: "Accepted",
      uncertain: true,
      deliveryEvidence: "provider_accepted",
      evidenceRef: "appended",
    });
    expect(JSON.stringify(r)).not.toMatch(/Delivered/);
    expect(r.history.map((h: any) => h.outcome)).toEqual(["accepted"]);
  });

  it("only the owner's evidence moves Accepted to Confirmed, and only from Accepted", async () => {
    const id = await insertEvent(OWNER, "approval.completed", approvedEvent(), "owner");
    await dispatch({ workspaceId: OWNER }, dbl);
    for (const evidenceRef of ["", "has space", "<script>", "x".repeat(201)]) {
      const bad = await ownerCall(`/api/v1/admin/automations/runs/${id}/confirm`, {
        method: "POST",
        body: { evidenceRef },
      });
      expect(bad.status, evidenceRef).toBe(400);
    }
    const ok = await ownerCall(`/api/v1/admin/automations/runs/${id}/confirm`, {
      method: "POST",
      body: { evidenceRef: "zap-run-TEST-001" },
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      label: "Confirmed",
      uncertain: false,
      evidenceRef: "zap-run-TEST-001",
    });
    expect(await auditCount("automation.confirmed", id)).toBe(1);
    // Again: refused, since it is no longer Accepted.
    expect(
      (
        await ownerCall(`/api/v1/admin/automations/runs/${id}/confirm`, {
          method: "POST",
          body: { evidenceRef: "zap-run-2" },
        })
      ).status,
    ).toBe(409);
    // A Simulated run can never be confirmed.
    const sim = await insertEvent(
      OWNER,
      "case.created",
      { caseRef: "CASE-00000001", caseType: "Billing", queue: "Field Services" },
      "owner",
    );
    await dispatch({ workspaceId: OWNER });
    expect((await outboxRow(OWNER, sim)).dispatch_state).toBe("simulated");
    expect(
      (
        await ownerCall(`/api/v1/admin/automations/runs/${sim}/confirm`, {
          method: "POST",
          body: { evidenceRef: "zap-run-3" },
        })
      ).status,
    ).toBe(409);
  });

  it("guests can list their runs with labels but can't reach any operator control", async () => {
    const g = await launch();
    await setRole(g.cookie, "manager");
    const c = (await packCases(g))["case-3"] as { id: string; version: number };
    const detail = await call(`/api/v1/cases/${c.id}`, { cookie: g.cookie });
    await guestDecide(g, detail.json.approval.id, c.version);
    const runs = await call("/api/v1/automations/runs", { cookie: g.cookie });
    expect(runs.status).toBe(200);
    expect(runs.json.items.map((r: any) => r.label)).toEqual(["Simulated"]);
    const id = runs.json.items[0].id;
    for (const path of [`runs/${id}/retry`, `runs/${id}/confirm`, "pause", "dispatch"]) {
      const res = await call(`/api/v1/admin/automations/${path}`, {
        method: "POST",
        cookie: g.cookie,
        body: {},
      });
      expect([401, 403, 404], path).toContain(res.status);
    }
    // The owner's runs are invisible from a guest workspace.
    const ownerRun = await insertEvent(
      OWNER,
      "case.created",
      { caseRef: "CASE-00000002", caseType: "Billing", queue: "Field Services" },
      "owner",
    );
    expect((await call(`/api/v1/automations/runs/${ownerRun}`, { cookie: g.cookie })).status).toBe(
      404,
    );
  });
});

describe("P4.4 retry, dead letter and the emergency stop", () => {
  it("duplicate operator retries produce one retry and one audit row", async () => {
    const id = await insertEvent(OWNER, "approval.completed", approvedEvent(), "owner");
    dbl.faults.push({ op: "read", fault: { status: 403 } });
    await dispatch({ workspaceId: OWNER }, dbl);
    expect((await run(id)).label).toBe("Failed");
    const before = await auditCount("automation.retried", id);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ownerCall(`/api/v1/admin/automations/runs/${id}/retry`, { method: "POST", dbl }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect(await auditCount("automation.retried", id)).toBe(before + 1);
    // The retry dispatched after commit and the sheet check kept it to one row.
    expect((await outboxRow(OWNER, id)).dispatch_state).toBe("accepted");
    expect(dbl.rows.filter((r) => r[0] === id)).toHaveLength(1);
    expect(await effectsOf(OWNER, id)).toHaveLength(1);
  });

  it("retry is refused for anything that isn't Failed", async () => {
    const id = await insertEvent(OWNER, "approval.completed", approvedEvent(), "owner");
    await dispatch({ workspaceId: OWNER }, dbl);
    const res = await ownerCall(`/api/v1/admin/automations/runs/${id}/retry`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("not_dead_letter");
  });

  it("the emergency stop holds every event Queued, loses none, and resumes cleanly", async () => {
    const g = await launch();
    expect(
      (
        await ownerCall("/api/v1/admin/automations/pause", {
          method: "POST",
          body: { paused: true },
        })
      ).status,
    ).toBe(400);
    const paused = await ownerCall("/api/v1/admin/automations/pause", {
      method: "POST",
      body: { paused: true, reason: "Rehearsal stop" },
    });
    expect(paused.json).toMatchObject({ paused: true, reason: "Rehearsal stop" });
    const owned = await insertEvent(OWNER, "approval.completed", approvedEvent(), "owner");
    const guest = await insertEvent(g.workspaceId, "case.created", {
      caseRef: "CASE-00000003",
      caseType: "Billing",
      queue: "Field Services",
    });
    expect(await dispatch({ max: 10 }, dbl)).toEqual([]);
    expect((await run(owned)).label).toBe("Queued");
    expect((await call(`/api/v1/automations/runs/${guest}`, { cookie: g.cookie })).json.label).toBe(
      "Queued",
    );
    expect(dbl.requests).toHaveLength(0);
    const resumed = await ownerCall("/api/v1/admin/automations/pause", {
      method: "POST",
      body: { paused: false },
    });
    expect(resumed.json.paused).toBe(false);
    await drain(OWNER, dbl);
    await drain(g.workspaceId);
    expect((await run(owned)).label).toBe("Accepted");
    expect((await call(`/api/v1/automations/runs/${guest}`, { cookie: g.cookie })).json.label).toBe(
      "Simulated",
    );
    expect(await auditCount("automation.paused", "automation")).toBeGreaterThanOrEqual(1);
    expect(await auditCount("automation.resumed", "automation")).toBeGreaterThanOrEqual(1);
  });

  it("the status page states the live claims honestly", async () => {
    const res = await ownerCall("/api/v1/admin/automations", { dbl });
    expect(res.json.sheetBridge).toEqual({
      configured: true,
      testDouble: true,
      claim: "Pending Owner Credentials",
    });
    expect(res.json.zapier.claim).toBe("Pending Owner Configuration");
  });
});

describe("P4.5 rehearsal across the complete path", () => {
  it("P4-A duplicate approval clicks and retries make one durable event and one effect", async () => {
    const { caseId, version, approvalId } = await ownerReadyCase();
    const sameKey = idempotencyKey();
    const clicks = await Promise.all([
      ...Array.from({ length: 6 }, () =>
        ownerCall(`/api/v1/approvals/${approvalId}/decision`, {
          method: "POST",
          dbl,
          body: { decision: "approve", caseVersion: version },
        }),
      ),
      ...Array.from({ length: 4 }, () =>
        mintOwnerToken().then((token) =>
          call(`/api/v1/approvals/${approvalId}/decision`, {
            method: "POST",
            env: { ...ownerEnv, ...dbl.env },
            headers: { ...sameKey, "cf-access-jwt-assertion": token },
            body: { decision: "approve", caseVersion: version },
          }),
        ),
      ),
    ]);
    expect(clicks.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    const events = (await eventsOf(OWNER, "approval.completed")).filter(
      (e) => e.idempotency_key === `approval:${approvalId}`,
    );
    expect(events).toHaveLength(1);
    await drain(OWNER, dbl);
    const e = events[0];
    expect((await outboxRow(OWNER, e.id)).dispatch_state).toBe("accepted");
    expect(dbl.rows.filter((r) => r[0] === e.id)).toHaveLength(1);
    expect(await effectsOf(OWNER, e.id)).toHaveLength(1);
    const mig = await connect("opsbridge_migrator");
    expect(
      (await mig.query("SELECT status FROM app.cases WHERE id = $1", [caseId])).rows[0].status,
    ).toBe("Approved");
    await mig.end();
  });

  it("P4-B an unavailable sheet doesn't lose the event or touch the case", async () => {
    const { caseId, version, approvalId } = await ownerReadyCase();
    dbl.faults.push({ op: "token", fault: { status: 503 } });
    const res = await ownerCall(`/api/v1/approvals/${approvalId}/decision`, {
      method: "POST",
      dbl,
      key: true,
      body: { decision: "approve", caseVersion: version },
    });
    expect(res.status).toBe(200);
    const [event] = (await eventsOf(OWNER, "approval.completed")).filter(
      (e) => e.idempotency_key === `approval:${approvalId}`,
    );
    expect(event.dispatch_state).toBe("retry_scheduled");
    const mig = await connect("opsbridge_migrator");
    const caseRow = async () =>
      (await mig.query("SELECT status, version FROM app.cases WHERE id = $1", [caseId])).rows[0];
    const approved = await caseRow();
    expect(approved).toEqual({ status: "Approved", version: version + 1 });
    await makeDue(OWNER, event.id);
    await dispatch({ workspaceId: OWNER }, dbl);
    expect((await outboxRow(OWNER, event.id)).dispatch_state).toBe("accepted");
    expect(await caseRow()).toEqual(approved);
    await mig.end();
  });

  it("a blocked destination dead-letters without harming the case, and an operator retry recovers once", async () => {
    const { caseId, version, approvalId } = await ownerReadyCase();
    dbl.faults.push({ op: "read", fault: { status: 403 } });
    await ownerCall(`/api/v1/approvals/${approvalId}/decision`, {
      method: "POST",
      dbl,
      key: true,
      body: { decision: "approve", caseVersion: version },
    });
    const [event] = (await eventsOf(OWNER, "approval.completed")).filter(
      (e) => e.idempotency_key === `approval:${approvalId}`,
    );
    expect(event).toMatchObject({
      dispatch_state: "dead_letter",
      last_error_code: "sheet_forbidden",
    });
    const retry = await ownerCall(`/api/v1/admin/automations/runs/${event.id}/retry`, {
      method: "POST",
      dbl,
    });
    expect(retry.status).toBe(200);
    expect((await outboxRow(OWNER, event.id)).dispatch_state).toBe("accepted");
    expect(dbl.rows.filter((r) => r[0] === event.id)).toHaveLength(1);
    expect((await attemptsOf(OWNER, event.id)).map((a) => a.outcome)).toEqual([
      "dead_letter",
      "accepted",
    ]);
    const mig = await connect("opsbridge_migrator");
    expect(
      (await mig.query("SELECT status FROM app.cases WHERE id = $1", [caseId])).rows[0].status,
    ).toBe("Approved");
    await mig.end();
  });

  it("P4-E restart and replay: abandoned claims finish once, replays add no effects", async () => {
    const g = await launch();
    const ids = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        await insertEvent(g.workspaceId, "case.needs_review", {
          caseRef: `CASE-0000AB0${i}`,
          reason: "intake",
          queue: "Field Services",
        }),
      );
    const owned = await insertEvent(OWNER, "approval.completed", approvedEvent(), "owner");
    // A process claims everything and dies before delivering.
    const mig = await connect("opsbridge_migrator");
    await mig.query("SELECT * FROM app.claim_due_outbox(10, $1)", [g.workspaceId]);
    await mig.query("SELECT * FROM app.claim_due_outbox(10, $1)", [OWNER]);
    await mig.query(
      "UPDATE app.outbox SET lease_expires_at = now() - interval '1 second' WHERE dispatch_state = 'processing' AND workspace_id = ANY($1)",
      [[g.workspaceId, OWNER]],
    );
    await drain(g.workspaceId);
    await drain(OWNER, dbl);
    for (const id of ids) {
      expect((await outboxRow(g.workspaceId, id)).dispatch_state).toBe("simulated");
      expect(await effectsOf(g.workspaceId, id)).toHaveLength(1);
    }
    expect((await outboxRow(OWNER, owned)).dispatch_state).toBe("accepted");
    // Replay everything: put the events back to Pending as a careless operator might, and run again.
    await mig.query(
      "UPDATE app.outbox SET dispatch_state = 'pending', delivery_evidence = 'none', evidence_ref = NULL, next_attempt_at = now(), attempts = 0 WHERE id = ANY($1)",
      [[...ids, owned]],
    );
    await mig.end();
    await drain(g.workspaceId);
    await drain(OWNER, dbl);
    for (const id of ids) expect(await effectsOf(g.workspaceId, id)).toHaveLength(1);
    expect(await effectsOf(OWNER, owned)).toHaveLength(1);
    expect(dbl.rows.filter((r) => r[0] === owned)).toHaveLength(1);
    expect((await outboxRow(OWNER, owned)).evidence_ref).toMatch(/^found-by-check:/);
    expect((await counts(g.workspaceId, ["automation_effects"])).automation_effects).toBe(5);
  });

  it("P4-D a demo workspace with a sheet rule never reaches the sheet, whatever the request carries", async () => {
    const g = await launch();
    await setRole(g.cookie, "manager");
    const c = (await packCases(g))["case-3"] as { id: string; version: number };
    const detail = await call(`/api/v1/cases/${c.id}`, { cookie: g.cookie });
    const res = await call(`/api/v1/approvals/${detail.json.approval.id}/decision`, {
      method: "POST",
      cookie: g.cookie,
      env: dbl.env,
      headers: {
        ...idempotencyKey(),
        "x-sink": "sheet_bridge",
        "x-destination": "https://attacker.example",
      },
      body: { decision: "approve", caseVersion: c.version },
    });
    expect(res.status).toBe(200);
    await drain(g.workspaceId, dbl);
    expect(dbl.requests).toHaveLength(0);
    const [event] = await eventsOf(g.workspaceId, "approval.completed");
    expect(event.dispatch_state).toBe("simulated");
    const effects = await effectsOf(g.workspaceId, event.id);
    expect(effects.every((e) => e.sink === "simulated")).toBe(true);
    // Extra body fields are refused outright.
    const extra = await call(`/api/v1/approvals/${detail.json.approval.id}/decision`, {
      method: "POST",
      cookie: g.cookie,
      headers: idempotencyKey(),
      body: { decision: "approve", caseVersion: c.version + 1, destination: "https://x" },
    });
    expect(extra.status).toBe(400);
  });
});
