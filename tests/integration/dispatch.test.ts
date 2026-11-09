// P4.2 durable dispatch and P4.3's bridge, against the labeled Sheets double. Nothing here
// touches Google: P4-C stays Pending Owner Credentials.
import { beforeEach, describe, expect, it } from "vitest";
import { withClient } from "../../backend/src/db";
import { claimDue, deliver, finish, plan } from "../../backend/src/jobs/dispatch";
import { forgetSheetToken, SHEET_ROW_CAP } from "../../backend/src/integrations/sinks";
import {
  approvedEvent,
  attemptsOf,
  dispatch,
  drain,
  effectsOf,
  envWith,
  expireLease,
  insertEvent,
  makeDue,
  OWNER_RULE_ID,
  OWNER_WORKSPACE_ID as OWNER,
  outboxRow,
} from "./automation-helpers";
import { connect, launch } from "./harness";
import { type SheetsDouble, sheetsDouble } from "./sheets-double";

let dbl: SheetsDouble;
beforeEach(async () => {
  dbl = await sheetsDouble();
  forgetSheetToken();
  // Earlier files leave owner events behind; settle them so each test starts clean.
  await drain(OWNER);
});

const ownerEvent = () => insertEvent(OWNER, "approval.completed", approvedEvent(), "owner");

describe("P4.2 claims and leases", () => {
  it("racing dispatchers claim each event once and lose none", async () => {
    const g = await launch();
    const ids = [];
    for (let i = 0; i < 12; i++) {
      ids.push(
        await insertEvent(g.workspaceId, "case.needs_review", {
          caseRef: `CASE-${String(i).padStart(8, "0")}`,
          reason: "intake",
          queue: "Field Services",
        }),
      );
    }
    const passes = await Promise.all(
      Array.from({ length: 8 }, () => dispatch({ workspaceId: g.workspaceId, max: 3 })),
    );
    const claimed = passes.flat().map((o) => o.id);
    expect(new Set(claimed).size).toBe(claimed.length);
    await drain(g.workspaceId);
    for (const id of ids) {
      const row = await outboxRow(g.workspaceId, id);
      expect(row.dispatch_state).toBe("simulated");
      expect(row.attempts).toBe(1);
      expect((await attemptsOf(g.workspaceId, id)).map((a) => a.outcome)).toEqual(["simulated"]);
      expect(await effectsOf(g.workspaceId, id)).toHaveLength(1);
    }
  });

  it("never claims template rows, even the three seeded in pending", async () => {
    const mig = await connect("opsbridge_migrator");
    const q =
      "SELECT count(*)::int AS n FROM app.outbox o JOIN app.workspaces w ON w.id = o.workspace_id WHERE w.mode = 'template' AND o.dispatch_state = 'pending' AND o.attempts = 0";
    const before = (await mig.query(q)).rows[0].n;
    expect(before).toBe(3);
    for (let i = 0; i < 5; i++) await dispatch({ max: 10 });
    expect((await mig.query(q)).rows[0].n).toBe(3);
    await mig.end();
  });

  it("a crash between delivery and acknowledgement is repaired by the next claim, with one row (check-before-append)", async () => {
    const id = await ownerEvent();
    const env = envWith(dbl.env);
    await withClient(env.HYPERDRIVE, async (db) => {
      const claim = (await claimDue(db, 10, OWNER)).find((c) => c.id === id);
      expect(claim).toBeDefined();
      if (!claim) return;
      const planned = await plan(db, env, claim);
      expect(planned.sink.mode).toBe("sheet_bridge");
      const result = await deliver(planned, claim);
      expect(result.kind).toBe("accepted");
      // The Worker dies here: no finish.
    });
    expect(dbl.rows).toHaveLength(1);
    expect((await outboxRow(OWNER, id)).dispatch_state).toBe("processing");
    // A tick inside the lease finds nothing to do.
    expect((await dispatch({ workspaceId: OWNER }, dbl)).map((o) => o.id)).not.toContain(id);
    await expireLease(OWNER, id);
    const [out] = await dispatch({ workspaceId: OWNER }, dbl);
    expect(out?.state).toBe("accepted");
    expect(dbl.rows).toHaveLength(1);
    const row = await outboxRow(OWNER, id);
    expect(row).toMatchObject({
      dispatch_state: "accepted",
      delivery_evidence: "provider_accepted",
      attempts: 2,
    });
    expect(row.evidence_ref).toMatch(/^found-by-check:Events!A\d+$/);
    expect((await attemptsOf(OWNER, id)).map((a) => a.outcome)).toEqual([
      "lease_expired",
      "accepted",
    ]);
    expect(await effectsOf(OWNER, id)).toEqual([
      { rule_id: OWNER_RULE_ID, rule_version: 1, action: "sheet_append", sink: "sheet_bridge" },
    ]);
  });

  it("a finisher whose lease was reclaimed can't overwrite the newer attempt", async () => {
    const g = await launch();
    const id = await insertEvent(g.workspaceId, "case.needs_review", {
      caseRef: "CASE-0000BEEF",
      reason: "intake",
      queue: "Field Services",
    });
    const env = envWith();
    await withClient(env.HYPERDRIVE, async (db) => {
      const [first] = await claimDue(db, 1, g.workspaceId);
      if (!first) throw new Error("no claim");
      await expireLease(g.workspaceId, id);
      const [second] = await claimDue(db, 1, g.workspaceId);
      if (!second) throw new Error("no reclaim");
      expect(second.lease_token).not.toBe(first.lease_token);
      const planned = await plan(db, env, first);
      expect(await finish(db, first, planned, { kind: "retryable", code: "timeout" })).toBe(
        "stale",
      );
      expect(
        await finish(db, second, planned, { kind: "simulated", evidenceRef: "simulated:1-rule" }),
      ).toBe("simulated");
    });
    expect((await attemptsOf(g.workspaceId, id)).map((a) => a.outcome)).toEqual([
      "lease_expired",
      "simulated",
    ]);
  });

  it("a lease that runs out at the attempt cap goes to Dead Letter instead of a seventh try", async () => {
    const g = await launch();
    const id = await insertEvent(g.workspaceId, "case.created", {
      caseRef: "CASE-0000CAFE",
      caseType: "Billing",
      queue: "Field Services",
    });
    const mig = await connect("opsbridge_migrator");
    await mig.query(
      "UPDATE app.outbox SET dispatch_state = 'processing', attempts = 6, lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    await mig.end();
    await dispatch({ workspaceId: g.workspaceId });
    const row = await outboxRow(g.workspaceId, id);
    expect(row).toMatchObject({
      dispatch_state: "dead_letter",
      attempts: 6,
      last_error_code: "lease_expired",
      lease_token: null,
    });
  });
});

describe("P4.2 retries, backoff and dead letter (provider faults on the double)", () => {
  const secondsUntil = (at: Date) => (at.getTime() - Date.now()) / 1000;

  it("an unavailable sheet schedules a retry no sooner than 120 s and loses nothing", async () => {
    const id = await ownerEvent();
    dbl.faults.push({ op: "read", fault: { status: 503 } });
    await dispatch({ workspaceId: OWNER }, dbl);
    const row = await outboxRow(OWNER, id);
    expect(row).toMatchObject({
      dispatch_state: "retry_scheduled",
      last_error_code: "provider_unavailable",
      delivery_evidence: "none",
    });
    expect(secondsUntil(row.next_attempt_at)).toBeGreaterThan(115);
    expect(dbl.rows).toHaveLength(0);
    // Not due yet: a tick leaves it alone.
    expect((await dispatch({ workspaceId: OWNER }, dbl)).map((o) => o.id)).not.toContain(id);
    await makeDue(OWNER, id);
    await dispatch({ workspaceId: OWNER }, dbl);
    expect((await outboxRow(OWNER, id)).dispatch_state).toBe("accepted");
    expect(dbl.rows).toHaveLength(1);
  });

  it("429 honors Retry-After beyond the floor", async () => {
    const id = await ownerEvent();
    dbl.faults.push({ op: "read", fault: { status: 429, retryAfter: 900 } });
    await dispatch({ workspaceId: OWNER }, dbl);
    const row = await outboxRow(OWNER, id);
    expect(row.last_error_code).toBe("rate_limited");
    expect(secondsUntil(row.next_attempt_at)).toBeGreaterThan(895);
  });

  it("a timed-out append that landed late is found by the retry's check: one row, not two", async () => {
    const id = await ownerEvent();
    dbl.faults.push({ op: "append", fault: "append_then_timeout" });
    await dispatch({ workspaceId: OWNER }, dbl);
    expect(await outboxRow(OWNER, id)).toMatchObject({
      dispatch_state: "retry_scheduled",
      last_error_code: "timeout",
    });
    expect(dbl.rows).toHaveLength(1);
    await makeDue(OWNER, id);
    await dispatch({ workspaceId: OWNER }, dbl);
    const row = await outboxRow(OWNER, id);
    expect(row.dispatch_state).toBe("accepted");
    expect(row.evidence_ref).toMatch(/^found-by-check:/);
    expect(dbl.rows).toHaveLength(1);
  });

  it("401 gets one token refresh inside the attempt", async () => {
    const id = await ownerEvent();
    await dispatch({ workspaceId: OWNER }, dbl); // warms the token
    const second = await ownerEvent();
    dbl.faults.push({ op: "read", fault: { status: 401 } });
    const tokenCalls = () => dbl.requests.filter((r) => r.path === "/token").length;
    const before = tokenCalls();
    await dispatch({ workspaceId: OWNER }, dbl);
    expect(tokenCalls()).toBe(before + 1);
    expect((await outboxRow(OWNER, id)).dispatch_state).toBe("accepted");
    expect((await outboxRow(OWNER, second)).dispatch_state).toBe("accepted");
  });

  it("403 and 404 are permanent: Dead Letter at once, no retry", async () => {
    for (const status of [403, 404]) {
      const id = await ownerEvent();
      dbl.faults.push({ op: "read", fault: { status } });
      await dispatch({ workspaceId: OWNER }, dbl);
      const row = await outboxRow(OWNER, id);
      expect(row.dispatch_state).toBe("dead_letter");
      expect(row.last_error_code).toBe(status === 403 ? "sheet_forbidden" : "sheet_not_found");
      expect(row.attempts).toBe(1);
    }
  });

  it("a sink that stays down reaches Dead Letter at attempt 6, with the whole history kept", async () => {
    const id = await ownerEvent();
    for (let i = 0; i < 6; i++) {
      dbl.faults.push({ op: "read", fault: "timeout" });
      await makeDue(OWNER, id);
      await dispatch({ workspaceId: OWNER }, dbl);
    }
    const row = await outboxRow(OWNER, id);
    expect(row).toMatchObject({
      dispatch_state: "dead_letter",
      attempts: 6,
      last_error_code: "timeout",
    });
    const history = await attemptsOf(OWNER, id);
    expect(history.map((a) => a.outcome)).toEqual([
      ...Array(5).fill("retry_scheduled"),
      "dead_letter",
    ]);
    expect(history.map((a) => a.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(dbl.rows).toHaveLength(0);
  });

  it("a full sheet stops appending instead of growing past the cap", async () => {
    const id = await ownerEvent();
    for (let i = 0; i < SHEET_ROW_CAP; i++) dbl.rows.push([`old-${i}`]);
    await dispatch({ workspaceId: OWNER }, dbl);
    expect(await outboxRow(OWNER, id)).toMatchObject({
      dispatch_state: "dead_letter",
      last_error_code: "sheet_full",
    });
    expect(dbl.rows).toHaveLength(SHEET_ROW_CAP);
  });

  it("the row written is sanitized: event ID first, short references, TEST mode, no formulas", async () => {
    const id = await insertEvent(
      OWNER,
      "approval.completed",
      { caseRef: "=HYPERLINK(1)", decision: "approved", queue: "Field Services" },
      "owner",
    );
    await dispatch({ workspaceId: OWNER }, dbl);
    const row = dbl.rows.find((r) => r[0] === id);
    expect(row).toBeDefined();
    expect(row?.[1]).toBe("approval.completed");
    expect(row?.[3]).toBe("'=HYPERLINK(1)");
    expect(row?.[5]).toBe("TEST");
    expect(row?.join("|")).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-.*-.*-.*[|].*[0-9a-f]{8}-[0-9a-f]{4}/,
    );
  });
});

describe("P4.3 the bridge stays off until configured", () => {
  it("without Sheets configuration an owner sheet rule finishes Simulated and nothing is sent", async () => {
    const id = await ownerEvent();
    await dispatch({ workspaceId: OWNER });
    const row = await outboxRow(OWNER, id);
    expect(row.dispatch_state).toBe("simulated");
    expect(await effectsOf(OWNER, id)).toEqual([
      { rule_id: OWNER_RULE_ID, rule_version: 1, action: "sheet_append", sink: "simulated" },
    ]);
  });

  it("a test double is ignored outside local runs, so it can't stand in for a real sheet", async () => {
    // Checked at the configuration step on purpose: dispatching here would send a real request.
    const { sheetConfig } = await import("../../backend/src/integrations/sinks");
    expect(sheetConfig(envWith(dbl.env))?.double).toBe(true);
    const staged = sheetConfig(envWith({ ...dbl.env, ENVIRONMENT: "staging" }));
    expect(staged?.double).toBe(false);
    expect(staged?.transport).not.toBe(dbl.env.SHEETS_TEST_DOUBLE);
    expect(sheetConfig(envWith({ ...dbl.env, SHEETS_ENABLED: "false" }))).toBeNull();
    expect(sheetConfig(envWith({ ...dbl.env, SHEET_ID: "https://evil.example/x" }))).toBeNull();
    expect(sheetConfig(envWith({ ...dbl.env, GOOGLE_SA_KEY: "not json" }))).toBeNull();
    expect(dbl.requests).toHaveLength(0);
  });
});

describe("independent review fixes (P4 review M1, L1)", () => {
  // Called as the runtime role with no workspace context, as SQL misuse in the request path would.
  async function asApp<T>(fn: (c: Awaited<ReturnType<typeof connect>>) => Promise<T>) {
    const c = await connect("opsbridge_app");
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  it("the database refuses to finish a demo event as Accepted or through the Sheet bridge", async () => {
    const g = await launch();
    const id = await insertEvent(g.workspaceId, "approval.completed", approvedEvent());
    const mig = await connect("opsbridge_migrator");
    const rule = (
      await mig.query(
        "SELECT id, version FROM app.workflow_rules WHERE workspace_id = $1 AND action = 'sheet_append'",
        [g.workspaceId],
      )
    ).rows[0];
    await mig.end();
    await asApp(async (c) => {
      const [claim] = (await c.query("SELECT * FROM app.claim_due_outbox(1, $1)", [g.workspaceId]))
        .rows;
      const fin = (outcome: string, sink: string, effects: unknown[]) =>
        c.query("SELECT app.finish_outbox($1, $2, $3, $4, $5, NULL, NULL, $6, $7) AS s", [
          g.workspaceId,
          id,
          claim.lease_token,
          outcome,
          "Events!A2",
          sink,
          JSON.stringify(effects),
        ]);
      const sheetEffect = [
        {
          ruleId: rule.id,
          ruleVersion: rule.version,
          action: "sheet_append",
          sink: "sheet_bridge",
        },
      ];
      await expect(fin("accepted", "sheet_bridge", sheetEffect)).rejects.toThrow(/owner workspace/);
      await expect(fin("simulated", "sheet_bridge", [])).rejects.toThrow(/owner workspace/);
      await expect(fin("simulated", "simulated", sheetEffect)).rejects.toThrow(/sheet bridge/);
      await expect(
        fin("simulated", "simulated", [
          { ruleId: rule.id, ruleVersion: 99, action: "sheet_append" },
        ]),
      ).rejects.toThrow(/does not match a rule/);
      await expect(
        fin("simulated", "simulated", [
          { ruleId: crypto.randomUUID(), ruleVersion: 1, action: "simulated_notice" },
        ]),
      ).rejects.toThrow(/does not match a rule/);
      await expect(fin("accepted", "simulated", [])).rejects.toThrow(/owner workspace/);
    });
    // Nothing stuck: the lease is still held, and the real dispatcher finishes it honestly.
    await expireLease(g.workspaceId, id);
    await drain(g.workspaceId);
    const row = await outboxRow(g.workspaceId, id);
    expect(row).toMatchObject({ dispatch_state: "simulated", delivery_evidence: "none" });
    expect((await effectsOf(g.workspaceId, id)).every((e) => e.sink === "simulated")).toBe(true);
  });

  it("an owner event can't be marked Accepted without a live sink", async () => {
    const id = await ownerEvent();
    await asApp(async (c) => {
      const [claim] = (
        await c.query("SELECT * FROM app.claim_due_outbox(10, $1)", [OWNER])
      ).rows.filter((r) => r.id === id);
      await expect(
        c.query(
          "SELECT app.finish_outbox($1, $2, $3, 'accepted', 'x', NULL, NULL, 'simulated', '[]')",
          [OWNER, id, claim.lease_token],
        ),
      ).rejects.toThrow(/live sink/);
    });
  });

  it("a Retry-After beyond the 1-hour backoff cap is honored", async () => {
    const id = await ownerEvent();
    dbl.faults.push({ op: "read", fault: { status: 429, retryAfter: 7200 } });
    await dispatch({ workspaceId: OWNER }, dbl);
    const row = await outboxRow(OWNER, id);
    expect((row.next_attempt_at.getTime() - Date.now()) / 1000).toBeGreaterThan(7190);
  });
});
