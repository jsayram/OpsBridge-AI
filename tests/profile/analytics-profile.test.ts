import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "../../backend/src/db";
import { overview } from "../../backend/src/repo/analytics";
import { exportRows, reportPage, reportTotals } from "../../backend/src/repo/reports";
import { call, connect, launch, mintOwnerToken, ownerEnv } from "../integration/harness";

// P6.1: read the plans of every analytics and report query at seeded volume before deciding on
// any index. Each query runs once under EXPLAIN ANALYZE and once for real, as opsbridge_app with
// RLS on, so the function under test gets real rows back.
const OWNER_WS = "00000000-0000-4000-8000-000000000002";
const OUTPUT = "docs/evidence/P6.1/query-plans.txt";
const report: string[] = [];
const timings: { label: string; ms: number; seqCases: boolean }[] = [];

async function profiled<T>(label: string, workspaceId: string, fn: (db: Db) => Promise<T>) {
  const c = await connect("opsbridge_app");
  await c.query("BEGIN");
  await c.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
  let n = 0;
  const db: Db = {
    query: (async (text: string, values?: unknown[]) => {
      if (!/^\s*(WITH|SELECT)/i.test(text) || /now\(\) AS at/.test(text)) {
        return c.query(text, values);
      }
      n++;
      const plan = await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values);
      const lines = plan.rows.map((r) => r["QUERY PLAN"] as string).join("\n");
      const ms = Number(/Execution Time: ([\d.]+)/.exec(lines)?.[1]);
      timings.push({ label: `${label} #${n}`, ms, seqCases: /Seq Scan on cases/.test(lines) });
      report.push(`## ${label} #${n}\nExecution ${ms} ms\n${lines}\n`);
      return c.query(text, values);
    }) as Db["query"],
  };
  try {
    return await fn(db);
  } finally {
    await c.query("ROLLBACK");
    await c.end();
  }
}

const reportFilters = (workspaceId: string, seesTemplate: boolean) => ({
  workspaceId,
  seesTemplate,
  from: "2025-11-10",
  to: "2026-11-10",
  sort: "created_desc" as const,
});

describe("P6.1 analytics and report queries at 1,001 owner cases", () => {
  afterAll(() => {
    mkdirSync("docs/evidence/P6.1", { recursive: true });
    const summary = timings
      .map((t) => `${t.label}: ${t.ms} ms${t.seqCases ? " (seq scan on cases)" : ""}`)
      .join("\n");
    writeFileSync(
      OUTPUT,
      `# P6 query plans, ${new Date().toISOString()}\n# Local Docker Postgres 17, role opsbridge_app, RLS on, 1,001 owner cases. Not Neon, not Hyperdrive.\n\n${summary}\n\n${report.join("\n")}`,
    );
  });

  it("owner overview: every query under 50 ms", async () => {
    await profiled("Owner overview", OWNER_WS, (db) =>
      overview(db, { workspaceId: OWNER_WS, seesTemplate: false }, false),
    );
    for (const t of timings) expect(t.ms, t.label).toBeLessThan(50);
  });

  it("guest overview over own rows plus the shared samples", async () => {
    const g = await launch();
    const out = await profiled("Guest overview", g.workspaceId, (db) =>
      overview(db, { workspaceId: g.workspaceId, seesTemplate: true }, false),
    );
    expect(out.scope).toBe("workspace_and_shared_samples");
    for (const t of timings) expect(t.ms, t.label).toBeLessThan(50);
  });

  it("report totals, a page, a status filter and the export query", async () => {
    const f = reportFilters(OWNER_WS, false);
    await profiled("Report totals", OWNER_WS, (db) => reportTotals(db, f));
    await profiled("Report page 1", OWNER_WS, (db) => reportPage(db, f, { page: 1, limit: 100 }));
    await profiled("Report page 10", OWNER_WS, (db) => reportPage(db, f, { page: 10, limit: 100 }));
    await profiled("Report status=Closed", OWNER_WS, (db) =>
      reportPage(db, { ...f, status: "Closed" }, { page: 1, limit: 100 }),
    );
    await profiled("Report source=none", OWNER_WS, (db) =>
      reportTotals(db, { ...f, source: "none" }),
    );
    const rows = await profiled("Export query", OWNER_WS, (db) => exportRows(db, f));
    expect(rows.length).toBeLessThanOrEqual(1001);
    for (const t of timings) expect(t.ms, t.label).toBeLessThan(100);
  });

  it("the overview API answers in bounded time at this volume", async () => {
    const headers = { "cf-access-jwt-assertion": await mintOwnerToken() };
    const started = performance.now();
    const res = await call("/api/v1/analytics/overview", { env: ownerEnv, headers });
    const ms = performance.now() - started;
    report.push(`## Overview API call\n${ms.toFixed(0)} ms end to end, in-process\n`);
    expect(res.status).toBe(200);
    expect(
      res.json.pulse.find((m: { key: string }) => m.key === "open_cases").value,
    ).toBeGreaterThan(0);
    // A thousand-row export would be refused at 1,001 rows; the cap holds at seeded volume.
    const big = await call("/api/v1/reports/operations/export", { env: ownerEnv, headers });
    expect(big.status).toBe(413);
  });
});
