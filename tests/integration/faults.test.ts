import { describe, expect, it } from "vitest";
import {
  call,
  connect,
  counts,
  findings,
  type Guest,
  launch,
  type Source,
  setRole,
  sources,
  sync,
} from "./harness";

const fresh = async () => {
  const guest = await launch();
  await setRole(guest.cookie, "manager");
  return { guest, list: await sources(guest.cookie) };
};
const run = (guest: Guest, list: Record<string, Source>, provider: string, scenario: string) =>
  sync(guest.cookie, (list[provider] as Source).id, { scenario });
const resume = (guest: Guest, connectionId: string, runId: string) =>
  call(`/api/v1/integrations/${connectionId}/runs/${runId}/resume`, {
    method: "POST",
    cookie: guest.cookie,
  });
const lastCursor = async (guest: Guest, provider: string) => {
  const mig = await connect("opsbridge_migrator");
  const { rows } = await mig.query(
    "SELECT last_cursor, status FROM app.external_connections WHERE workspace_id = $1 AND provider = $2",
    [guest.workspaceId, provider],
  );
  await mig.end();
  return rows[0];
};

describe("PRD 8.4 transport faults (P3-C)", () => {
  it("429, then success: retried in bounds, nothing corrupted (E2E-08 on CRM)", async () => {
    const { guest, list } = await fresh();
    const res = await run(guest, list, "crm_simulator", "http_429");
    expect(res.json.status).toBe("succeeded");
    expect(res.json.counts.created).toBe(3);
    expect(res.json.resumes).toBe(0);
  });

  it("a brief 500 recovers inside the retry budget", async () => {
    const { guest, list } = await fresh();
    const res = await run(guest, list, "erp_simulator", "http_5xx_transient");
    expect(res.json.status).toBe("succeeded");
    expect(res.json.counts.seen).toBe(17);
  });

  it("an outage fails the run after bounded retries, keeps the cursor, and resume finishes it", async () => {
    const { guest, list } = await fresh();
    const res = await run(guest, list, "erp_simulator", "http_5xx_outage");
    expect(res.json.status).toBe("failed");
    expect(res.json.error.class).toBe("transient");
    expect(res.json.error.code).toBe("http_500");
    expect(res.json.pages).toBe(1);
    expect(res.json.cursorSaved).toBe(true);
    const held = await lastCursor(guest, "erp_simulator");
    expect(held.last_cursor).toBeNull();
    expect(held.status).toBe("Degraded");
    const mig = await connect("opsbridge_migrator");
    const events = await mig.query(
      "SELECT payload FROM app.outbox WHERE workspace_id = $1 AND event_type = 'integration.degraded'",
      [guest.workspaceId],
    );
    await mig.end();
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload.data).toEqual({ provider: "erp_simulator", status: "degraded" });
    const done = await resume(guest, (list.erp_simulator as Source).id, res.json.id);
    expect(done.json.status).toBe("succeeded");
    expect(done.json.resumes).toBe(1);
    expect(done.json.counts.seen).toBe(17);
    expect((await counts(guest.workspaceId, ["invoices"])).invoices).toBe(12);
    const healed = await lastCursor(guest, "erp_simulator");
    expect(healed.status).toBe("Simulated");
    expect(healed.last_cursor).not.toBeNull();
  });

  it("a timeout behaves as transient", async () => {
    const { guest, list } = await fresh();
    const res = await run(guest, list, "inventory_simulator", "timeout");
    expect(res.json.status).toBe("failed");
    expect(res.json.error.code).toBe("timeout");
  });

  it("a long Retry-After isn't slept through", async () => {
    const { guest, list } = await fresh();
    const started = Date.now();
    const res = await run(guest, list, "erp_simulator", "http_429_long");
    expect(res.json.status).toBe("failed");
    expect(res.json.error.class).toBe("rate_limited");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("401 goes straight to dead letter with no retries, and the demo keeps working (E2E-09)", async () => {
    const { guest, list } = await fresh();
    const started = Date.now();
    const res = await run(guest, list, "crm_simulator", "http_401");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.json.status).toBe("dead_letter");
    expect(res.json.error.class).toBe("auth");
    expect(res.json.error.message).toMatch(/credentials/);
    expect((await sources(guest.cookie)).crm_simulator?.status).toBe("Degraded");
    expect((await call("/api/v1/cases?limit=1", { cookie: guest.cookie })).status).toBe(200);
  });

  it("403 is a permission dead letter", async () => {
    const { guest, list } = await fresh();
    const res = await run(guest, list, "erp_simulator", "http_403");
    expect(res.json.status).toBe("dead_letter");
    expect(res.json.error.class).toBe("permission");
  });

  it("a malformed page is a dead letter and keeps nothing from it", async () => {
    const { guest, list } = await fresh();
    const res = await run(guest, list, "erp_simulator", "malformed_payload");
    expect(res.json.status).toBe("dead_letter");
    expect(res.json.error.code).toBe("malformed_json");
    expect((await counts(guest.workspaceId, ["source_records"])).source_records).toBe(4);
  });

  it("a resume is an operator action, and it is bounded", async () => {
    const { guest, list } = await fresh();
    const res = await run(guest, list, "crm_simulator", "http_403");
    const id = (list.crm_simulator as Source).id;
    await setRole(guest.cookie, "analyst");
    expect((await resume(guest, id, res.json.id)).status).toBe(403);
    await setRole(guest.cookie, "manager");
    const mig = await connect("opsbridge_migrator");
    await mig.query("UPDATE app.sync_runs SET resumes = 5 WHERE id = $1", [res.json.id]);
    await mig.end();
    expect((await resume(guest, id, res.json.id)).json.code).toBe("retry_exhausted");
    const other = await launch();
    await setRole(other.cookie, "manager");
    expect((await resume(other, id, res.json.id)).status).toBe(404);
  });

  it("a finished run can't be resumed", async () => {
    const { guest, list } = await fresh();
    const res = await run(guest, list, "crm_simulator", "baseline");
    const out = await resume(guest, (list.crm_simulator as Source).id, res.json.id);
    expect(out.json.code).toBe("run_finished");
  });

  it("diagnostics carry a code and a fixed message, with no provider text", async () => {
    const { guest, list } = await fresh();
    await run(guest, list, "erp_simulator", "http_401");
    await run(guest, list, "crm_simulator", "http_5xx_outage");
    const res = await call("/api/v1/integrations", { cookie: guest.cookie });
    expect(res.text).not.toMatch(
      /INVALID_LOGIN|o:errorDetails|Simulated CRM error|simulator\.invalid/,
    );
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT coalesce(string_agg(summary, ' '), '') AS s FROM app.audit_events WHERE workspace_id = $1",
      [guest.workspaceId],
    );
    await mig.end();
    expect(rows[0].s).not.toMatch(/INVALID_LOGIN|o:errorDetails|simulator\.invalid/);
  });
});

describe("findings from the independent review", () => {
  it("an old failed run can't resume after a newer run, so nothing is falsely deleted", async () => {
    const { guest, list } = await fresh();
    const id = (list.erp_simulator as Source).id;
    const failed = await sync(guest.cookie, id, { scenario: "http_5xx_outage" });
    expect((await sync(guest.cookie, id, { full: true })).json.status).toBe("succeeded");
    const res = await resume(guest, id, failed.json.id);
    expect(res.json.code).toBe("run_superseded");
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT count(*)::int AS n FROM app.source_records WHERE workspace_id = $1 AND state = 'deleted'",
      [guest.workspaceId],
    );
    await mig.end();
    expect(rows[0].n).toBe(0);
  });

  it("a rejected record isn't counted as deleted", async () => {
    const { guest, list } = await fresh();
    const id = (list.erp_simulator as Source).id;
    await sync(guest.cookie, id);
    const res = await sync(guest.cookie, id, { scenario: "privileged_field" });
    expect(res.json.counts.rejected).toBe(1);
    expect(res.json.counts.marked_deleted).toBe(0);
    expect((await findings(guest.cookie)).some((f) => f.kind === "source_deleted")).toBe(false);
  });

  it("a read with a stream missing can't delete that stream", async () => {
    const { guest, list } = await fresh();
    await sync(guest.cookie, (list.erp_simulator as Source).id);
    const mig = await connect("opsbridge_migrator");
    await mig.query(
      "UPDATE app.source_records SET external_type = 'organization' WHERE workspace_id = $1 AND external_id = '5001'",
      [guest.workspaceId],
    );
    await mig.end();
    const res = await sync(guest.cookie, (list.erp_simulator as Source).id, { full: true });
    // The ERP read has no organization stream, so that row stays, whatever it was.
    expect(res.json.counts.marked_deleted).toBe(0);
  });

  it("an approval rechecks the source: a change that was reverted makes the evidence stale", async () => {
    const { guest, list } = await fresh();
    const id = (list.erp_simulator as Source).id;
    await sync(guest.cookie, id, { scenario: "renamed_customer" });
    const newer = (await findings(guest.cookie)).find(
      (f) => f.kind === "name_mismatch" && f.supersedes,
    );
    // The source goes back to its older name, which is a fact the queue has already seen.
    const mig = await connect("opsbridge_migrator");
    await mig.query(
      "UPDATE app.source_records SET data = jsonb_set(data, '{name}', '\"Cedar Point Landscaping, Inc. (fictional)\"') WHERE workspace_id = $1 AND external_id = '6001'",
      [guest.workspaceId],
    );
    await mig.end();
    const moved = await call(`/api/v1/reconciliation/${newer.id}/advance`, {
      method: "POST",
      cookie: guest.cookie,
      body: { to: "Investigating", version: newer.version },
    });
    const proposed = await call(`/api/v1/reconciliation/${newer.id}/advance`, {
      method: "POST",
      cookie: guest.cookie,
      body: { to: "Proposed", version: moved.json.version, proposal: "Take the new name" },
    });
    const res = await call(`/api/v1/reconciliation/${newer.id}/resolve`, {
      method: "POST",
      cookie: guest.cookie,
      headers: { "idempotency-key": `revert-${Date.now()}` },
      body: { decision: "approve", version: proposed.json.version },
    });
    expect(res.json.code).toBe("evidence_stale");
    const customers = await call("/api/v1/customers", { cookie: guest.cookie });
    expect(customers.text).not.toContain("Outdoor Services");
  });

  it("an invoice that moves to another bill-to follows it, and the newest copy in a page wins", async () => {
    const { guest, list } = await fresh();
    const id = (list.erp_simulator as Source).id;
    await sync(guest.cookie, id);
    const mig = await connect("opsbridge_migrator");
    await mig.query(
      `UPDATE app.invoices SET bill_to_external_id = '6001', customer_id = (SELECT canonical_id FROM app.external_record_links l
         WHERE l.workspace_id = $1 AND l.external_id = '6001'), source_modified_at = source_modified_at - interval '1 day'
       WHERE workspace_id = $1 AND bill_to_external_id = '5002'`,
      [guest.workspaceId],
    );
    const res = await sync(guest.cookie, id, { full: true });
    expect(res.json.counts.updated).toBeGreaterThan(0);
    const { rows } = await mig.query(
      "SELECT customer_id FROM app.invoices WHERE workspace_id = $1 AND bill_to_external_id = '5002'",
      [guest.workspaceId],
    );
    await mig.end();
    expect(rows.length).toBeGreaterThan(0);
    // 5002 isn't mapped yet, so the stale client is gone rather than kept.
    expect(rows.every((r) => r.customer_id === null)).toBe(true);
  });
});

describe("PRD 8.4 data faults", () => {
  it("duplicate events add one row each", async () => {
    const { guest, list } = await fresh();
    const res = await run(guest, list, "erp_simulator", "duplicate_event");
    expect(res.json.status).toBe("succeeded");
    expect(res.json.counts.duplicate_skipped).toBeGreaterThan(0);
    expect((await counts(guest.workspaceId, ["source_records"])).source_records).toBe(5);
    expect((await counts(guest.workspaceId, ["invoices"])).invoices).toBe(12);
  });

  it("out-of-order delivery keeps the newest values (E2E-07)", async () => {
    const { guest, list } = await fresh();
    const res = await run(guest, list, "erp_simulator", "out_of_order");
    expect(res.json.counts.stale_skipped).toBeGreaterThan(0);
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT data ->> 'name' AS name FROM app.source_records WHERE workspace_id = $1 AND external_id = '6001'",
      [guest.workspaceId],
    );
    await mig.end();
    expect(rows[0].name).toContain("Incorporated");
  });

  it("a stale version changes nothing", async () => {
    const { guest, list } = await fresh();
    const erp = (list.erp_simulator as Source).id;
    await sync(guest.cookie, erp);
    const res = await run(guest, list, "erp_simulator", "stale_version");
    expect(res.json.counts.stale_skipped).toBe(1);
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT data ->> 'name' AS name FROM app.source_records WHERE workspace_id = $1 AND external_id = '6001'",
      [guest.workspaceId],
    );
    await mig.end();
    expect(rows[0].name).not.toContain("OLD");
  });

  it("a deleted record keeps the canonical customer and opens a finding", async () => {
    const { guest, list } = await fresh();
    const erp = (list.erp_simulator as Source).id;
    await sync(guest.cookie, erp);
    const customers = (await counts(guest.workspaceId, ["customers"])).customers;
    const res = await run(guest, list, "erp_simulator", "deleted_record");
    expect(res.json.counts.marked_deleted).toBe(1);
    expect((await counts(guest.workspaceId, ["customers"])).customers).toBe(customers);
    const f = (await findings(guest.cookie)).find((x) => x.kind === "source_deleted");
    expect(f.evidence.sources[0].externalId).toBe("6001");
    // It comes back and the record is active again. The finding stays as history.
    await sync(guest.cookie, erp, { full: true });
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT state FROM app.source_records WHERE workspace_id = $1 AND external_id = '6001'",
      [guest.workspaceId],
    );
    await mig.end();
    expect(rows[0].state).toBe("active");
  });

  it("a mismatched account ID opens a high finding, and nothing changes until approval", async () => {
    const { guest, list } = await fresh();
    await run(guest, list, "erp_simulator", "mismatched_account");
    const f = (await findings(guest.cookie)).find((x) => x.kind === "account_mismatch");
    expect(f.severity).toBe("high");
    expect(f.evidence.differences[0].values).toEqual({ canonical: "NS-1002", erp: "NS-2002" });
    const customers = await call("/api/v1/customers", { cookie: guest.cookie });
    expect(customers.text).not.toContain("NS-2002");
  });

  it("an unknown field is dropped and counted, never stored", async () => {
    const { guest, list } = await fresh();
    const res = await run(guest, list, "erp_simulator", "unknown_field");
    expect(res.json.counts.unknown_fields_dropped).toBe(1);
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT data::text AS d FROM app.source_records WHERE workspace_id = $1",
      [guest.workspaceId],
    );
    await mig.end();
    expect(rows.map((r) => r.d).join()).not.toContain("dropped and counted");
  });

  it("a privileged field rejects that record and can't steer the workspace", async () => {
    const { guest, list } = await fresh();
    const res = await run(guest, list, "erp_simulator", "privileged_field");
    expect(res.json.status).toBe("succeeded");
    expect(res.json.counts.rejected).toBe(1);
    expect(res.json.counts.rejected_sample[0]).toEqual({
      externalId: "5001",
      reason: "privileged_field",
    });
    expect((await counts(guest.workspaceId, ["source_records"])).source_records).toBe(4);
  });
});
