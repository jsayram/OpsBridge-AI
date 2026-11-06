import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sweepDemoWorkspaces } from "../../backend/src/jobs/sweep";
import {
  baseEnv,
  call,
  connect,
  counts,
  findings,
  type Guest,
  idempotencyKey,
  launch,
  packCases,
  type Source,
  setRole,
  sources,
  sync,
  syncAll,
  withLimits,
} from "./harness";

const fresh = async () => {
  const guest = await launch();
  await setRole(guest.cookie, "manager");
  return guest;
};

const advance = (cookie: string, f: any, to: string, proposal?: string) =>
  call(`/api/v1/reconciliation/${f.id}/advance`, {
    method: "POST",
    cookie,
    body: { to, version: f.version, ...(proposal ? { proposal } : {}) },
  });

const resolve = (cookie: string, f: any, body: Record<string, unknown>) =>
  call(`/api/v1/reconciliation/${f.id}/resolve`, {
    method: "POST",
    cookie,
    headers: idempotencyKey(),
    body: { version: f.version, ...body },
  });

const find = async (guest: Guest, kind: string, subject?: string) =>
  (await findings(guest.cookie)).find(
    (f) => f.kind === kind && (!subject || f.subject === subject),
  );

async function toProposed(guest: Guest, f: any) {
  const a = await advance(guest.cookie, f, "Investigating");
  const b = await advance(guest.cookie, a.json, "Proposed", "Finance reviewed the entities.");
  expect(b.status).toBe(200);
  return b.json;
}

describe("P3.4 showcase: CRM customer versus ERP customer (P3-H, JOB-TEST-01)", () => {
  it("shows why the records are related but not interchangeable", async () => {
    const guest = await fresh();
    const f = await find(guest, "definition_conflict");
    expect(f.severity).toBe("high");
    expect(f.status).toBe("Open");
    expect(f.evidence.matchBasis).toBe("exact_id");
    expect(f.evidence.rule.ref).toBe("R-CUST-1");
    const systems = f.evidence.sources.map((s: any) => [s.system, s.externalId]);
    expect(systems).toEqual([
      ["CRM (simulated)", "CRM-ORG-1001"],
      ["ERP Simulator", "5001"],
      ["ERP Simulator", "5002"],
    ]);
    expect(f.evidence.differences[0].field).toBe("customer definition");
    expect(f.evidence.differences[0].values.erp).toMatch(/billable legal entity/);
    for (const s of f.evidence.sources) expect(Date.parse(s.sourceTimestamp)).not.toBeNaN();
  });

  it("approval keeps one customer, two bill-tos, and each invoice on its own bill-to", async () => {
    const guest = await fresh();
    await syncAll(guest.cookie);
    const before = await counts(guest.workspaceId, ["customers"]);
    const f = await toProposed(guest, await find(guest, "definition_conflict"));
    const done = await resolve(guest.cookie, f, { decision: "approve" });
    expect(done.status).toBe(200);
    expect(done.json.status).toBe("Resolved");
    expect((await counts(guest.workspaceId, ["customers"])).customers).toBe(before.customers);
    const list = await call("/api/v1/customers", { cookie: guest.cookie });
    const harbor = list.json.items.find((c: any) => c.name.startsWith("Harbor Ridge"));
    const view = await call(`/api/v1/reconciliation/customers/${harbor.id}`, {
      cookie: guest.cookie,
    });
    const billTos = view.json.sources.filter((s: any) => s.role === "erp_bill_to");
    expect(billTos.map((s: any) => s.externalId)).toEqual(["5001", "5002"]);
    expect(billTos.every((s: any) => s.approvedBy === "manager")).toBe(true);
    expect(billTos.every((s: any) => s.invoices > 0)).toBe(true);
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      `SELECT DISTINCT bill_to_external_id FROM app.invoices WHERE workspace_id = $1 AND customer_id = $2 ORDER BY 1`,
      [guest.workspaceId, harbor.id],
    );
    expect(rows.map((r) => r.bill_to_external_id)).toEqual(["5001", "5002"]);
    const mapping = await mig.query(
      "SELECT mapping_rule_ref, approved_by, field_authority FROM app.source_definition_mappings WHERE workspace_id = $1",
      [guest.workspaceId],
    );
    expect(mapping.rows).toHaveLength(1);
    expect(mapping.rows[0].mapping_rule_ref).toBe("R-CUST-1");
    expect(mapping.rows[0].field_authority.legalName).toBe("erp");
    const audit = await mig.query(
      "SELECT action FROM app.audit_events WHERE workspace_id = $1 AND target = $2 ORDER BY id",
      [guest.workspaceId, f.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "finding.advanced",
      "finding.advanced",
      "finding.approved",
    ]);
    const events = await mig.query(
      "SELECT idempotency_key, payload FROM app.outbox WHERE workspace_id = $1 AND event_type = 'reconciliation.resolved'",
      [guest.workspaceId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].idempotency_key).toBe(`finding:${f.id}:resolved`);
    expect(Object.keys(events.rows[0].payload.data).sort()).toEqual(["findingRef", "kind"]);
    await mig.end();
    // Replaying the same snapshot preserves the distinction (PRD 8.5).
    const replay = await syncAll(guest.cookie);
    for (const res of replay) expect(res.json.counts.findings_opened).toBe(0);
    const again = await call(`/api/v1/reconciliation/customers/${harbor.id}`, {
      cookie: guest.cookie,
    });
    expect(again.json.sources.filter((s: any) => s.role === "erp_bill_to")).toHaveLength(2);
    expect(
      (await findings(guest.cookie)).filter((x) => x.kind === "definition_conflict"),
    ).toHaveLength(1);
  });

  it("rejection changes nothing and the same evidence doesn't come back", async () => {
    const guest = await fresh();
    await syncAll(guest.cookie);
    const f = await find(guest, "definition_conflict");
    const links = await counts(guest.workspaceId, ["external_record_links"]);
    expect((await resolve(guest.cookie, f, { decision: "reject" })).status).toBe(400);
    const done = await resolve(guest.cookie, f, { decision: "reject", reason: "Not ready" });
    expect(done.json.status).toBe("Dismissed");
    expect(await counts(guest.workspaceId, ["external_record_links"])).toEqual(links);
    await sync(guest.cookie, (await sources(guest.cookie)).erp_simulator?.id as string, {
      full: true,
    });
    expect(
      (await findings(guest.cookie)).filter((x) => x.kind === "definition_conflict"),
    ).toHaveLength(1);
  });
});

describe("P3.4 matching and resolution", () => {
  it("P3-F: a similar or equal normalized name never links on its own", async () => {
    const guest = await fresh();
    await syncAll(guest.cookie);
    const f = await find(guest, "duplicate_client");
    expect(f.evidence.matchBasis).toBe("normalized_name");
    expect(f.evidence.needsTarget).toBe(true);
    const mig = await connect("opsbridge_migrator");
    const links = await mig.query(
      "SELECT 1 FROM app.external_record_links WHERE workspace_id = $1 AND external_id = '6002'",
      [guest.workspaceId],
    );
    expect(links.rowCount).toBe(0);
    await mig.end();
    // Even approval needs a person to name the customer.
    const ready = await toProposed(guest, f);
    const refused = await resolve(guest.cookie, ready, { decision: "approve" });
    expect(refused.status).toBe(400);
    const linked = await resolve(guest.cookie, ready, {
      decision: "approve",
      targetCustomerId: f.evidence.suggestedCustomerId,
    });
    expect(linked.status).toBe(200);
  });

  it("approval of a missing client creates a customer once, then replays cleanly", async () => {
    const guest = await fresh();
    await syncAll(guest.cookie);
    const before = (await counts(guest.workspaceId, ["customers"])).customers ?? 0;
    const f = await find(guest, "missing_client", "erp:customer:7001");
    const proposed = await advance(guest.cookie, f, "Proposed", "Add Bluebird as a client.");
    expect(proposed.status).toBe(200);
    const done = await resolve(guest.cookie, proposed.json, { decision: "approve" });
    expect(done.status).toBe(200);
    expect((await counts(guest.workspaceId, ["customers"])).customers).toBe(before + 1);
    await syncAll(guest.cookie);
    expect((await counts(guest.workspaceId, ["customers"])).customers).toBe(before + 1);
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT count(*)::int AS n FROM app.invoices WHERE workspace_id = $1 AND bill_to_external_id = '7001' AND customer_id IS NOT NULL",
      [guest.workspaceId],
    );
    expect(rows[0].n).toBeGreaterThan(0);
    await mig.end();
  });

  it("targetCustomerId from another workspace is refused and writes nothing", async () => {
    const guest = await fresh();
    const other = await fresh();
    await syncAll(guest.cookie);
    const stranger = (await call("/api/v1/customers", { cookie: other.cookie })).json.items[0].id;
    const f = await toProposed(guest, await find(guest, "duplicate_client"));
    const res = await resolve(guest.cookie, f, { decision: "approve", targetCustomerId: stranger });
    expect(res.status).toBe(404);
    expect((await find(guest, "duplicate_client")).status).toBe("Proposed");
  });

  it("E2E-10, renamed customer: new finding links the old one, and the old one can't be approved", async () => {
    const guest = await fresh();
    const list = await sources(guest.cookie);
    const old = await find(guest, "name_mismatch");
    expect(old.status).toBe("Proposed");
    await sync(guest.cookie, (list.erp_simulator as Source).id, { scenario: "renamed_customer" });
    const all = (await findings(guest.cookie)).filter((f) => f.kind === "name_mismatch");
    expect(all).toHaveLength(2);
    const newer = all.find((f) => f.id !== old.id);
    expect(newer.supersedes).toBe(old.id);
    expect(newer.severity).toBe("medium");
    expect(newer.evidence.differences[0].values.erp).toContain("Outdoor Services");
    const customers = await call("/api/v1/customers", { cookie: guest.cookie });
    expect(customers.text).not.toContain("Outdoor Services");
    const stale = all.find((f) => f.id === old.id);
    expect(stale.superseded).toBe(true);
    const refused = await resolve(guest.cookie, stale, { decision: "approve" });
    expect(refused.json.code).toBe("finding_superseded");
  });

  it("approve applies the ERP name; a changed customer makes the evidence stale", async () => {
    const guest = await fresh();
    const f = await find(guest, "name_mismatch");
    const done = await resolve(guest.cookie, f, { decision: "approve" });
    expect(done.status).toBe(200);
    const list = await call("/api/v1/customers", { cookie: guest.cookie });
    expect(list.text).toContain("Cedar Point Landscaping, Inc. (fictional)");
    const second = await fresh();
    const g = await find(second, "name_mismatch");
    const mig = await connect("opsbridge_migrator");
    await mig.query(
      "UPDATE app.customers SET canonical_name = 'Changed (fictional)' WHERE workspace_id = $1 AND pack_key = 'customer-2'",
      [second.workspaceId],
    );
    await mig.end();
    const res = await resolve(second.cookie, g, { decision: "approve" });
    expect(res.json.code).toBe("evidence_stale");
    expect((await find(second, "name_mismatch")).status).toBe("Proposed");
  });

  it("E2E-06: concurrent approvals give one effect and safe conflicts", async () => {
    const guest = await fresh();
    const f = await find(guest, "name_mismatch");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolve(guest.cookie, f, { decision: "approve" })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    const mig = await connect("opsbridge_migrator");
    const events = await mig.query(
      "SELECT count(*)::int AS n FROM app.outbox WHERE workspace_id = $1 AND event_type = 'reconciliation.resolved'",
      [guest.workspaceId],
    );
    const audit = await mig.query(
      "SELECT count(*)::int AS n FROM app.audit_events WHERE workspace_id = $1 AND action = 'finding.approved'",
      [guest.workspaceId],
    );
    await mig.end();
    expect(events.rows[0].n).toBe(1);
    expect(audit.rows[0].n).toBe(1);
  });

  it("an idempotent repeat replays and a stale version is refused", async () => {
    const guest = await fresh();
    const f = await find(guest, "name_mismatch");
    const headers = idempotencyKey();
    const body = { decision: "approve", version: f.version };
    const post = () =>
      call(`/api/v1/reconciliation/${f.id}/resolve`, {
        method: "POST",
        cookie: guest.cookie,
        headers,
        body,
      });
    const one = await post();
    const two = await post();
    expect(two.headers.get("idempotency-replayed")).toBe("true");
    expect(two.json.status).toBe(one.json.status);
    const stale = await advance(guest.cookie, f, "Investigating");
    expect(stale.json.code).toBe("stale_version");
  });

  it("role gates: viewer reads, analyst advances, only a reviewer decides", async () => {
    const guest = await fresh();
    const f = await find(guest, "definition_conflict");
    await setRole(guest.cookie, "viewer");
    expect((await advance(guest.cookie, f, "Investigating")).status).toBe(403);
    await setRole(guest.cookie, "analyst");
    const moved = await advance(guest.cookie, f, "Investigating");
    expect(moved.status).toBe(200);
    expect(
      (await resolve(guest.cookie, moved.json, { decision: "reject", reason: "x" })).status,
    ).toBe(403);
    await setRole(guest.cookie, "manager");
  });

  it("the state machine holds", async () => {
    const guest = await fresh();
    const f = await find(guest, "definition_conflict");
    expect((await advance(guest.cookie, f, "Proposed", "x")).json.code).toBe("invalid_transition");
    expect((await resolve(guest.cookie, f, { decision: "approve" })).json.code).toBe(
      "invalid_transition",
    );
    const inv = await advance(guest.cookie, f, "Investigating");
    expect((await advance(guest.cookie, inv.json, "Proposed")).status).toBe(400);
    const closed = await resolve(guest.cookie, inv.json, { decision: "reject", reason: "no" });
    expect(
      (
        await resolve(guest.cookie, closed.json, {
          decision: "defer",
          deferUntil: new Date(Date.now() + 86_400_000).toISOString(),
        })
      ).json.code,
    ).toBe("invalid_transition");
  });

  it("defer needs a date inside 90 days, and the sweep returns it to the queue", async () => {
    const guest = await fresh();
    const f = await find(guest, "definition_conflict");
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
    expect((await resolve(guest.cookie, f, { decision: "defer" })).status).toBe(400);
    expect(
      (await resolve(guest.cookie, f, { decision: "defer", deferUntil: day(-1) })).status,
    ).toBe(400);
    expect(
      (await resolve(guest.cookie, f, { decision: "defer", deferUntil: day(91) })).status,
    ).toBe(400);
    const deferred = await resolve(guest.cookie, f, { decision: "defer", deferUntil: day(5) });
    expect(deferred.json.status).toBe("Deferred");
    await sweepDemoWorkspaces(baseEnv());
    expect((await find(guest, "definition_conflict")).status).toBe("Deferred");
    const mig = await connect("opsbridge_migrator");
    await mig.query(
      "UPDATE app.reconciliation_findings SET defer_until = now() - interval '1 minute' WHERE workspace_id = $1 AND status = 'Deferred'",
      [guest.workspaceId],
    );
    await sweepDemoWorkspaces(baseEnv());
    const open = await find(guest, "definition_conflict");
    expect(open.status).toBe("Open");
    expect(open.deferUntil).toBeNull();
    const audit = await mig.query(
      "SELECT actor_role FROM app.audit_events WHERE workspace_id = $1 AND action = 'finding.undeferred'",
      [guest.workspaceId],
    );
    expect(audit.rows).toEqual([{ actor_role: "system" }]);
    await mig.end();
  });

  it("an analyst can bring a deferred finding back early", async () => {
    const guest = await fresh();
    const f = await find(guest, "definition_conflict");
    const deferred = await resolve(guest.cookie, f, {
      decision: "defer",
      deferUntil: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await setRole(guest.cookie, "analyst");
    const back = await advance(guest.cookie, deferred.json, "Open");
    expect(back.json.status).toBe("Open");
  });

  it("findings are scoped: another workspace's ID is absent, the template is read-only", async () => {
    const guest = await fresh();
    const other = await fresh();
    const f = await find(guest, "definition_conflict");
    expect((await call(`/api/v1/reconciliation/${f.id}`, { cookie: other.cookie })).status).toBe(
      404,
    );
    expect((await advance(other.cookie, f, "Investigating")).status).toBe(404);
    const shared = await findings(guest.cookie, "scope=shared&limit=100");
    expect(shared).toHaveLength(15);
    expect(shared.every((x) => x.readOnly)).toBe(true);
    const res = await advance(guest.cookie, shared[0], "Investigating");
    expect(res.status).toBe(403);
    expect(
      (await resolve(guest.cookie, shared[0], { decision: "reject", reason: "x" })).status,
    ).toBe(403);
  });

  it("customer lookups scope to the workspace", async () => {
    const guest = await fresh();
    const other = await fresh();
    const id = (await call("/api/v1/customers", { cookie: other.cookie })).json.items[0].id;
    expect(
      (await call(`/api/v1/reconciliation/customers/${id}`, { cookie: guest.cookie })).status,
    ).toBe(404);
  });

  it("list pages stay stable and bad input is refused", async () => {
    const guest = await fresh();
    await syncAll(guest.cookie);
    const a = await call("/api/v1/reconciliation?limit=4", { cookie: guest.cookie });
    const b = await call(`/api/v1/reconciliation?limit=4&cursor=${a.json.nextCursor}`, {
      cookie: guest.cookie,
    });
    const ids = [...a.json.items, ...b.json.items].map((f: any) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      (await call("/api/v1/reconciliation?cursor=nope", { cookie: guest.cookie })).status,
    ).toBe(400);
    expect((await call("/api/v1/reconciliation?status=Bad", { cookie: guest.cookie })).status).toBe(
      400,
    );
    expect((await call("/api/v1/reconciliation?limit=101", { cookie: guest.cookie })).status).toBe(
      400,
    );
  });

  it("the write cap stops a resolve cleanly", async () => {
    const guest = await fresh();
    const f = await find(guest, "name_mismatch");
    await advance(guest.cookie, await find(guest, "definition_conflict"), "Investigating");
    await withLimits({ write_cap: 1 }, async () => {
      const res = await resolve(guest.cookie, f, { decision: "approve" });
      expect(res.status).toBe(429);
    });
    expect((await find(guest, "name_mismatch")).status).toBe("Proposed");
  });

  it("no source system is written: every simulator call is a read", async () => {
    const source = readFileSync("backend/src/integrations/adapters.ts", "utf8");
    const posts = source.match(/method: "(\w+)"/g) ?? [];
    expect(posts).toEqual(['method: "POST"']);
    expect(source).toContain("suiteql");
  });
});

describe("P3.6 glossary", () => {
  it("the dictionary route matches DATA-DICTIONARY.md term for term", async () => {
    const guest = await fresh();
    const res = await call("/api/v1/reconciliation/definitions", { cookie: guest.cookie });
    const doc = readFileSync("DATA-DICTIONARY.md", "utf8");
    expect(res.json.terms).toHaveLength(9);
    for (const t of res.json.terms) expect(doc).toContain(`| ${t.term} |`);
    expect(Object.keys(res.json.rules)).toContain("R-CUST-1");
  });
});

describe("case cross-reference", () => {
  it("a case shows its client's source links and open findings", async () => {
    const guest = await fresh();
    const pack = await packCases(guest);
    const res = await call(`/api/v1/cases/${pack["case-2"]?.id}`, { cookie: guest.cookie });
    const refs = res.json.sourceReferences;
    expect(Array.isArray(refs.links)).toBe(true);
    expect(refs.links.length).toBeGreaterThan(0);
    expect(refs.openFindings.length).toBeGreaterThan(0);
  });
});
