import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { casePageSql } from "../../backend/src/repo/cases";
import { call, connect, launch, mintOwnerToken, ownerEnv } from "../integration/harness";

const OWNER_WS = "00000000-0000-4000-8000-000000000002";
const OUTPUT = "docs/evidence/P2.5/query-profile.txt";
const report: string[] = [];

async function plan(label: string, workspaceId: string, text: string, values: unknown[]) {
  const c = await connect("opsbridge_app");
  await c.query("BEGIN");
  await c.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
  const { rows } = await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values);
  await c.query("ROLLBACK");
  await c.end();
  const lines = rows.map((r) => r["QUERY PLAN"] as string);
  const execution = Number(/Execution Time: ([\d.]+)/.exec(lines.join("\n"))?.[1]);
  report.push(`## ${label}\nExecution ${execution} ms\n${lines.join("\n")}\n`);
  return { lines: lines.join("\n"), execution };
}

const owner = { workspaceId: OWNER_WS, seesTemplate: false, limit: 25 };

describe("P2-D 1,000 cases", () => {
  afterAll(() => {
    mkdirSync("docs/evidence/P2.5", { recursive: true });
    writeFileSync(
      OUTPUT,
      `# Query profile, ${new Date().toISOString()}\n# Local Docker Postgres 17, role opsbridge_app, RLS on, 1,001 owner cases, 3,000 audit rows. Not Neon.\n\n${report.join("\n")}`,
    );
  });

  it("the API walks every case with bounded pages and no repeat", async () => {
    const headers = { "cf-access-jwt-assertion": await mintOwnerToken() };
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    const started = performance.now();
    do {
      const q = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await call(`/api/v1/cases?${q}`, { env: ownerEnv, headers });
      expect(page.status).toBe(200);
      expect(page.json.items.length).toBeLessThanOrEqual(100);
      for (const x of page.json.items) {
        expect(seen.has(x.id)).toBe(false);
        seen.add(x.id);
      }
      cursor = page.json.nextCursor;
      pages++;
    } while (cursor);
    const elapsed = performance.now() - started;
    report.push(
      `## API walk\n${seen.size} cases, ${pages} pages, ${elapsed.toFixed(0)} ms total\n`,
    );
    expect(seen.size).toBe(1001);
    expect(pages).toBe(11);
  });

  it("the first page reads the list index and stops at the page size", async () => {
    const { text, values } = casePageSql(owner);
    const { lines, execution } = await plan("First page", OWNER_WS, text, values);
    expect(lines).toContain("cases_workspace_created");
    expect(lines).not.toMatch(/Seq Scan on cases/);
    expect(execution).toBeLessThan(50);
  });

  it("a deep page costs the same as the first, because the cursor seeks", async () => {
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM app.cases WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC OFFSET 900 LIMIT 1`,
      [OWNER_WS],
    );
    await mig.end();
    const cursor = { rank: 0 as const, at: rows[0].at, id: rows[0].id };
    const { text, values } = casePageSql({ ...owner, cursor });
    const { lines, execution } = await plan("Deep page, row 900", OWNER_WS, text, values);
    expect(lines).toContain("cases_workspace_created");
    expect(lines).not.toMatch(/Seq Scan on cases/);
    expect(execution).toBeLessThan(50);
  });

  it("status filter stays on an index", async () => {
    const { text, values } = casePageSql({ ...owner, status: "Closed" });
    const { lines, execution } = await plan("Status filter", OWNER_WS, text, values);
    expect(lines).toMatch(/Index.* on cases|Bitmap Index Scan on cases/);
    expect(execution).toBeLessThan(50);
  });

  it("search, overdue and assignee are bounded by the workspace and the page", async () => {
    for (const [label, extra] of [
      ["Search", { search: "Timesheet" }],
      ["Search with no match", { search: "no such text" }],
      ["Overdue", { overdue: true }],
      ["Unassigned", { unassigned: true }],
    ] as const) {
      const { text, values } = casePageSql({ ...owner, ...extra });
      const { execution } = await plan(label, OWNER_WS, text, values);
      expect(execution, label).toBeLessThan(50);
    }
  });

  it("a guest page unions two small index reads", async () => {
    const g = await launch();
    const { text, values } = casePageSql({
      workspaceId: g.workspaceId,
      seesTemplate: true,
      limit: 25,
    });
    const { lines, execution } = await plan("Guest own plus template", g.workspaceId, text, values);
    expect(lines).toContain("Append");
    expect(execution).toBeLessThan(50);
  });

  it("case activity uses its index", async () => {
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT target FROM app.audit_events WHERE workspace_id = $1 AND actor_id = 'profile' LIMIT 1",
      [OWNER_WS],
    );
    await mig.end();
    const { lines, execution } = await plan(
      "Case activity",
      OWNER_WS,
      `SELECT id, actor_type, actor_role, action, summary, occurred_at FROM app.audit_events
        WHERE workspace_id = $1 AND target = $2 ORDER BY id DESC LIMIT 26`,
      [OWNER_WS, rows[0].target],
    );
    expect(lines).toContain("audit_events_target");
    expect(execution).toBeLessThan(50);
  });
});
