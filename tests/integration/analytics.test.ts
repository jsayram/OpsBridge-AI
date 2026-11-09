import { beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_EVALUATION } from "../../backend/src/domain/metrics";
import {
  call,
  connect,
  findings,
  type Guest,
  idempotencyKey,
  launch,
  mintOwnerToken,
  ownerEnv,
  packCases,
  setRole,
} from "./harness";

const TEMPLATE = "00000000-0000-4000-8000-000000000001";
const OWNER_WS = "00000000-0000-4000-8000-000000000002";

// Recomputes every P6.1 number in JavaScript from raw rows read as the migrator, which RLS does
// not limit. Nothing here shares SQL with backend/src/repo/analytics.ts.
async function expected(workspaces: string[]) {
  const mig = await connect("opsbridge_migrator");
  const cases = (
    await mig.query(
      "SELECT status, due_at, created_at FROM app.cases WHERE workspace_id = ANY($1::uuid[])",
      [workspaces],
    )
  ).rows;
  const finds = (
    await mig.query(
      "SELECT status FROM app.reconciliation_findings WHERE workspace_id = ANY($1::uuid[])",
      [workspaces],
    )
  ).rows;
  const outbox = (
    await mig.query(
      "SELECT dispatch_state, delivery_evidence, attempts FROM app.outbox WHERE workspace_id = ANY($1::uuid[])",
      [workspaces],
    )
  ).rows;
  const reviews = (
    await mig.query(
      "SELECT status, abstain_reason FROM app.ai_reviews WHERE workspace_id = ANY($1::uuid[])",
      [workspaces],
    )
  ).rows;
  const docs = (
    await mig.query(
      "SELECT count(*)::int AS n FROM app.documents WHERE workspace_id = ANY($1::uuid[])",
      [workspaces],
    )
  ).rows[0].n;
  await mig.end();
  const n = (s: string) => cases.filter((c) => c.status === s).length;
  const open = ["Intake", "Needs Review", "Ready"];
  const now = Date.now();
  const label = (o: any) =>
    ["pending", "processing", "retry_scheduled"].includes(o.dispatch_state)
      ? "Queued"
      : o.dispatch_state === "dead_letter"
        ? "Failed"
        : o.dispatch_state === "simulated"
          ? "Simulated"
          : o.delivery_evidence === "confirmed"
            ? "Confirmed"
            : "Accepted";
  const labels = {
    Queued: 0,
    Accepted: 0,
    Confirmed: 0,
    Failed: 0,
    Simulated: 0,
  };
  for (const o of outbox) labels[label(o) as keyof typeof labels] += 1;
  const done = n("Approved") + n("Closed");
  const nonDraft = cases.length - n("Draft");
  return {
    open_cases: cases.filter((c) => open.includes(c.status)).length,
    completed_cases: done,
    draft_cases: n("Draft"),
    review_queue: n("Needs Review"),
    overdue_open: cases.filter(
      (c) => open.includes(c.status) && c.due_at && c.due_at.getTime() < now,
    ).length,
    open_findings: finds.filter((f) => !["Resolved", "Dismissed"].includes(f.status)).length,
    findings_resolved: finds.filter((f) => f.status === "Resolved").length,
    findings_dismissed: finds.filter((f) => f.status === "Dismissed").length,
    completion_rate: nonDraft ? done / nonDraft : null,
    statuses: Object.fromEntries(
      ["Draft", "Intake", "Needs Review", "Ready", "Approved", "Closed"].map((s) => [s, n(s)]),
    ),
    labels,
    automation_retries: outbox.reduce((a, o) => a + Math.max(o.attempts - 1, 0), 0),
    automation_failed: labels.Failed,
    manual_steps_avoided: (labels.Accepted + labels.Confirmed + labels.Simulated) * 3,
    documents: docs,
    ai_reviews: reviews.length,
    ai_abstained: reviews.filter((r) => r.abstain_reason !== null).length,
  };
}

const values = (list: { key: string; value: number | null }[]) =>
  Object.fromEntries(list.map((m) => [m.key, m.value]));

async function overviewValues(cookie?: string, headers?: Record<string, string>) {
  const res = await call("/api/v1/analytics/overview", {
    ...(cookie ? { cookie } : {}),
    ...(headers ? { headers, env: ownerEnv } : {}),
  });
  expect(res.status).toBe(200);
  const o = res.json;
  const v: Record<string, number | null> = {
    ...(values(o.pulse) as Record<string, number | null>),
    ...values(o.quality.metrics),
    ...values(o.ai.metrics),
    ...values(o.automation.metrics),
    completion_rate: o.funnel.completionRate.value,
  };
  return { raw: o, v };
}

async function reconciles(scope: string[], cookie?: string, headers?: Record<string, string>) {
  const { raw, v } = await overviewValues(cookie, headers);
  const e = await expected(scope);
  for (const key of [
    "open_cases",
    "completed_cases",
    "draft_cases",
    "review_queue",
    "overdue_open",
    "open_findings",
    "findings_resolved",
    "findings_dismissed",
    "automation_retries",
    "automation_failed",
    "manual_steps_avoided",
    "documents",
    "ai_reviews",
    "ai_abstained",
  ] as const) {
    expect(v[key], key).toBe(e[key]);
  }
  expect(v.completion_rate).toBeCloseTo(e.completion_rate as number, 10);
  expect(Object.fromEntries(raw.funnel.stages.map((s: any) => [s.status, s.count]))).toEqual(
    e.statuses,
  );
  expect(raw.automation.byLabel).toEqual(e.labels);
  return { raw, e, v };
}

describe("P6.1 overview reconciles with transactional rows", () => {
  let A: Guest;
  let B: Guest;

  beforeAll(async () => {
    A = await launch();
    B = await launch();
  });

  it("matches an independent count of the guest's rows plus the shared samples", async () => {
    const { raw } = await reconciles([A.workspaceId, TEMPLATE], A.cookie);
    expect(raw.scope).toBe("workspace_and_shared_samples");
    expect(raw.definitionVersion).toBe("metrics-1");
    // Every metric names a provenance from PRD 11.2, and the response explains each.
    const all = [
      ...raw.pulse,
      ...raw.quality.metrics,
      ...raw.ai.metrics,
      ...raw.automation.metrics,
    ];
    for (const m of all) {
      expect(["SYNTHETIC", "MEASURED_DEMO", "ESTIMATED", "UNKNOWN"]).toContain(m.provenance);
      expect(raw.glossary[m.key].formula.length).toBeGreaterThan(10);
    }
    expect(Object.keys(raw.provenanceText).sort()).toEqual([
      "ESTIMATED",
      "MEASURED_DEMO",
      "SYNTHETIC",
      "UNKNOWN",
    ]);
    expect(
      raw.automation.metrics.find((m: any) => m.key === "manual_steps_avoided").provenance,
    ).toBe("ESTIMATED");
  });

  it("still reconciles after case, approval, finding and handoff changes, for this guest only", async () => {
    await setRole(A.cookie, "manager");
    const before = (await overviewValues(A.cookie)).v;
    const otherBefore = (await overviewValues(B.cookie)).v;
    const pack = await packCases(A);
    const customer = (await call("/api/v1/customers", { cookie: A.cookie })).json.items[0].id;

    // A new case: one more open case.
    const created = await call("/api/v1/cases", {
      method: "POST",
      cookie: A.cookie,
      headers: idempotencyKey(),
      body: { title: "Analytics probe", customerId: customer, caseType: "Billing" },
    });
    expect(created.status).toBe(201);

    // Approve the Ready pack case through its pending approval: open down, completed up.
    const ready = pack["case-3"] as { id: string };
    const detail = await call(`/api/v1/cases/${ready.id}`, { cookie: A.cookie });
    const approved = await call(`/api/v1/approvals/${detail.json.approval.id}/decision`, {
      method: "POST",
      cookie: A.cookie,
      headers: idempotencyKey(),
      body: { decision: "approve", caseVersion: detail.json.version },
    });
    expect(approved.status).toBe(200);

    // Resolve one of the guest's own findings.
    const own = (await findings(A.cookie)).find(
      (f: any) => f.status === "Proposed" && f.readOnly === false,
    );
    expect(own).toBeTruthy();
    const resolved = await call(`/api/v1/reconciliation/${own.id}/resolve`, {
      method: "POST",
      cookie: A.cookie,
      headers: idempotencyKey(),
      body: { decision: "approve", version: own.version },
    });
    expect(resolved.status).toBe(200);

    const { v } = await reconciles([A.workspaceId, TEMPLATE], A.cookie);
    expect(v.open_cases).toBe((before.open_cases as number) + 1 - 1);
    expect(v.completed_cases).toBe((before.completed_cases as number) + 1);
    expect(v.open_findings).toBe((before.open_findings as number) - 1);
    expect(v.findings_resolved).toBe((before.findings_resolved as number) + 1);
    // B's workspace saw none of it.
    expect((await overviewValues(B.cookie)).v).toEqual(otherBefore);
  });

  it("an owner counts the owner workspace only, never the shared samples", async () => {
    const headers = { "cf-access-jwt-assertion": await mintOwnerToken() };
    const { raw } = await reconciles([OWNER_WS], undefined, headers);
    expect(raw.scope).toBe("workspace");
  });

  it("labels every source as simulated with its freshness, and nothing as live", async () => {
    const { raw } = await overviewValues(A.cookie);
    expect(raw.integration.sources.length).toBeGreaterThan(0);
    for (const s of raw.integration.sources) {
      expect(s.live).toBe(false);
      expect(["Simulated", "Connected test"]).toContain(s.sourceLabel);
      expect("lastSuccessAt" in s).toBe(true);
    }
    const age = raw.pulse.find((m: any) => m.key === "last_sync_age");
    if (raw.integration.lastSuccessAt === null) {
      expect(age).toMatchObject({ value: null, provenance: "UNKNOWN" });
    } else expect(age.value).toBeGreaterThanOrEqual(0);
  });

  it("never reports live AI cost as zero and keeps the evaluation labeled as fixture", async () => {
    const { raw } = await overviewValues(A.cookie);
    const cost = raw.ai.metrics.find((m: any) => m.key === "ai_live_cost");
    expect(cost).toMatchObject({ value: null, provenance: "UNKNOWN" });
    expect(raw.ai.liveState).toBe("pending_owner_credentials");
    expect(raw.ai.evaluation).toEqual(FIXTURE_EVALUATION);
    expect(raw.ai.evaluation.disclosure).toMatch(/Not live-model accuracy/);
    expect(JSON.stringify(raw.automation)).not.toMatch(/Delivered/);
  });

  it("refuses unknown parameters, a missing session and other routes' guesses", async () => {
    expect(
      (await call("/api/v1/analytics/overview?workspaceId=x", { cookie: A.cookie })).status,
    ).toBe(400);
    expect((await call("/api/v1/analytics/overview")).status).toBe(401);
    expect(
      (await call("/api/v1/analytics/trends?metric=revenue", { cookie: A.cookie })).status,
    ).toBe(400);
  });
});

describe("P6.1 snapshots and trends", () => {
  let A: Guest;

  beforeAll(async () => {
    A = await launch();
  });

  it("the shared 90-day synthetic history ends at the template's live count", async () => {
    const t = await call("/api/v1/analytics/trends?metric=open_cases", { cookie: A.cookie });
    expect(t.status).toBe(200);
    expect(t.json.shared.points).toHaveLength(90);
    expect(t.json.shared.provenance).toBe("SYNTHETIC");
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT count(*)::int AS n FROM app.cases WHERE workspace_id = $1 AND status IN ('Intake','Needs Review','Ready')",
      [TEMPLATE],
    );
    await mig.end();
    expect(t.json.shared.points.at(-1).value).toBe(rows[0].n);
  });

  it("a viewer can't record; a manager records one row per metric per day", async () => {
    await setRole(A.cookie, "viewer");
    expect(
      (await call("/api/v1/analytics/snapshots", { method: "POST", cookie: A.cookie })).status,
    ).toBe(403);
    await setRole(A.cookie, "manager");
    const one = await call("/api/v1/analytics/snapshots", { method: "POST", cookie: A.cookie });
    expect(one.status).toBe(201);
    const two = await call("/api/v1/analytics/snapshots", { method: "POST", cookie: A.cookie });
    expect(two.status).toBe(201);
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT metric_key, numerator::int AS n FROM app.metric_snapshots WHERE workspace_id = $1 ORDER BY 1",
      [A.workspaceId],
    );
    const own = await expected([A.workspaceId]);
    const audit = await mig.query(
      "SELECT count(*)::int AS n FROM app.audit_events WHERE workspace_id = $1 AND action = 'analytics.snapshot_recorded'",
      [A.workspaceId],
    );
    await mig.end();
    expect(rows).toHaveLength(5);
    expect(Object.fromEntries(rows.map((r) => [r.metric_key, r.n]))).toEqual({
      automation_failed: own.automation_failed,
      completed_cases: own.completed_cases,
      open_cases: own.open_cases,
      open_findings: own.open_findings,
      review_queue: own.review_queue,
    });
    expect(audit.rows[0].n).toBe(2);
    const t = await call("/api/v1/analytics/trends?metric=review_queue", { cookie: A.cookie });
    expect(t.json.own.points).toHaveLength(1);
    expect(t.json.own.points[0].value).toBe(own.review_queue);
  });

  it("a guest can't write a snapshot into the template or another workspace", async () => {
    const app = await connect("opsbridge_app");
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.workspace_id', $1, true)", [A.workspaceId]);
    const tried = await app
      .query(
        `INSERT INTO app.metric_snapshots (workspace_id, period, metric_key, numerator, provenance, definition_version)
         VALUES ($1, '2026-01-01', 'open_cases', 1, 'SYNTHETIC', 'metrics-1')`,
        [TEMPLATE],
      )
      .then(() => "inserted")
      .catch((e) => e.code);
    await app.query("ROLLBACK");
    await app.end();
    expect(tried).toBe("42501");
  });

  it("purge removes a workspace's snapshots", async () => {
    const victim = await launch();
    await setRole(victim.cookie, "manager");
    await call("/api/v1/analytics/snapshots", { method: "POST", cookie: victim.cookie });
    const mig = await connect("opsbridge_migrator");
    const clean = await connect("opsbridge_cleanup");
    await mig.query(
      "UPDATE app.workspaces SET expires_at = now() - interval '5 minutes' WHERE id = $1",
      [victim.workspaceId],
    );
    await clean.query("SELECT app.purge_demo_workspace($1)", [victim.workspaceId]);
    const left = await mig.query(
      "SELECT count(*)::int AS n FROM app.metric_snapshots WHERE workspace_id = $1",
      [victim.workspaceId],
    );
    await Promise.all([mig.end(), clean.end()]);
    expect(left.rows[0].n).toBe(0);
  });
});

// --- P6.3 ------------------------------------------------------------------------------------

const report = (cookie: string, qs: string) =>
  call(`/api/v1/reports/operations${qs ? `?${qs}` : ""}`, { cookie });
const exportCsv = (cookie: string, qs: string) =>
  call(`/api/v1/reports/operations/export${qs ? `?${qs}` : ""}`, { cookie });

// A minimal RFC 4180 reader for the test: quoted cells only, which is all the export writes.
const parseCsv = (text: string) =>
  text
    .trimEnd()
    .split("\r\n")
    .map((line) =>
      [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => (m[1] as string).replace(/""/g, '"')),
    );

// Named fixture F8: formula-prefix strings, which a spreadsheet would run.
// A leading tab is trimmed by the API's text rule, so the tab and carriage-return cases are in
// tests/unit/csv.test.ts instead.
const F8 = ['=HYPERLINK("http://example.com","x")', "+SUM(1,2)", "-2+3", "@cmd", "=1+1"];

describe("P6.3 reports and export", () => {
  let A: Guest;
  let B: Guest;

  beforeAll(async () => {
    A = await launch();
    B = await launch();
    const customer = (await call("/api/v1/customers", { cookie: A.cookie })).json.items[0].id;
    for (const title of F8) {
      const r = await call("/api/v1/cases", {
        method: "POST",
        cookie: A.cookie,
        headers: idempotencyKey(),
        body: { title, customerId: customer, caseType: "Renewal" },
      });
      expect(r.status).toBe(201);
    }
  });

  const combos = [
    "",
    "status=Intake",
    "status=Closed&sort=created_asc",
    "source=crm_simulator",
    "source=erp_simulator",
    "source=none",
    "assignee=unassigned",
    "from=2025-12-01&to=2026-01-31",
    "from=2020-01-01&to=2020-12-31",
  ];

  it.each(combos)("table, chart and CSV agree for %j", async (qs) => {
    const first = await report(A.cookie, `${qs}${qs ? "&" : ""}limit=100`);
    expect(first.status).toBe(200);
    const sum = Object.values(first.json.byStatus as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBe(first.json.total);
    const ids: string[] = [];
    for (let p = 1; p <= first.json.pages; p++) {
      const page = await report(A.cookie, `${qs}${qs ? "&" : ""}limit=100&page=${p}`);
      ids.push(...page.json.items.map((i: any) => i.id));
      for (const i of page.json.items) {
        if (first.json.filters.status) expect(i.status).toBe(first.json.filters.status);
      }
    }
    expect(ids).toHaveLength(first.json.total);
    const csv = await exportCsv(A.cookie, qs);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    const rows = parseCsv(csv.text);
    expect(rows[0]).toContain("Provenance");
    expect(rows.length - 1).toBe(first.json.total);
    expect(csv.headers.get("x-row-count")).toBe(String(first.json.total));
    const byStatus: Record<string, number> = {};
    for (const r of rows.slice(1)) byStatus[r[2] as string] = (byStatus[r[2] as string] ?? 0) + 1;
    for (const [s, n] of Object.entries(first.json.byStatus as Record<string, number>)) {
      expect(byStatus[s] ?? 0, s).toBe(n);
    }
    expect(rows.slice(1).every((r) => r.at(-1) === "SYNTHETIC")).toBe(true);
  });

  it("an empty range says zero everywhere and exports a header only", async () => {
    const r = await report(A.cookie, "from=2020-01-01&to=2020-01-31");
    expect(r.json).toMatchObject({ total: 0, pages: 0, items: [] });
    const csv = await exportCsv(A.cookie, "from=2020-01-01&to=2020-01-31");
    expect(parseCsv(csv.text)).toHaveLength(1);
  });

  it("an assignee filter matches the list's own assignee counts", async () => {
    const assignees = (await call("/api/v1/assignees", { cookie: A.cookie })).json.items;
    const pick = assignees[0];
    const r = await report(A.cookie, `assignee=${pick.id}&limit=100`);
    expect(r.json.total).toBeGreaterThan(0);
    expect(r.json.items.every((i: any) => i.assignee === pick.name)).toBe(true);
  });

  it("F8: formula-prefix text is neutralized in the CSV and left as typed in the table", async () => {
    const r = await report(A.cookie, "limit=100&sort=created_desc");
    const titles = r.json.items.map((i: any) => i.title);
    for (const t of F8) expect(titles).toContain(t);
    const csv = await exportCsv(A.cookie, "");
    const cells = parseCsv(csv.text).map((row) => row[0]);
    for (const t of F8) {
      expect(cells).toContain(`'${t}`);
      expect(cells).not.toContain(t);
    }
    // No cell in the whole file starts with a formula character.
    for (const row of parseCsv(csv.text)) {
      for (const cell of row) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    }
  });

  it("enforces the documented limits", async () => {
    expect((await report(A.cookie, "from=2024-01-01&to=2026-01-31")).json.code).toBe(
      "range_too_large",
    );
    expect((await report(A.cookie, "limit=101")).status).toBe(400);
    expect((await report(A.cookie, "limit=100&page=52")).status).toBe(400);
    expect((await report(A.cookie, "from=2026-02-30")).status).toBe(400);
    expect((await report(A.cookie, "from=2026-03-01&to=2026-02-01")).status).toBe(400);
    expect((await report(A.cookie, "status=Lost")).status).toBe(400);
    expect((await report(A.cookie, "status=Intake&status=Ready")).status).toBe(400);
  });

  it("refuses unscoped and other-workspace requests and leaks nothing", async () => {
    expect((await report(A.cookie, `workspaceId=${B.workspaceId}`)).status).toBe(400);
    expect((await exportCsv(A.cookie, `workspace=${B.workspaceId}`)).status).toBe(400);
    expect((await report("", "")).status).toBe(401);
    expect((await exportCsv("", "")).status).toBe(401);
    // B's own assignee id, asked for from A's session, finds nothing.
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT id FROM app.assignees WHERE workspace_id = $1 LIMIT 1",
      [B.workspaceId],
    );
    await mig.end();
    const cross = await report(A.cookie, `assignee=${rows[0].id}`);
    expect(cross.json.total).toBe(0);
    const all = await exportCsv(A.cookie, "");
    expect(all.text).not.toContain(B.workspaceId);
    const bTitles = (await report(B.cookie, "limit=100")).json.items
      .filter((i: any) => i.scope === "yours")
      .map((i: any) => i.title);
    for (const t of F8) expect(bTitles).not.toContain(t);
  });

  it("a viewer can read and export, as the permissions matrix allows", async () => {
    await setRole(B.cookie, "viewer");
    expect((await report(B.cookie, "")).status).toBe(200);
    expect((await exportCsv(B.cookie, "")).status).toBe(200);
  });

  it("refuses an export over the row cap instead of cutting it short", async () => {
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT id FROM app.customers WHERE workspace_id = $1 LIMIT 1",
      [B.workspaceId],
    );
    await mig.query(
      `INSERT INTO app.cases (workspace_id, customer_id, title, case_type, status)
       SELECT $1, $2, 'Bulk ' || g, 'Billing', 'Intake' FROM generate_series(1, 1001) g`,
      [B.workspaceId, rows[0].id],
    );
    await mig.end();
    await setRole(B.cookie, "analyst");
    const big = await exportCsv(B.cookie, "");
    expect(big.status).toBe(413);
    expect(big.json.code).toBe("export_too_large");
    // Narrowed, it works.
    expect((await exportCsv(B.cookie, "status=Ready")).status).toBe(200);
  });
});
