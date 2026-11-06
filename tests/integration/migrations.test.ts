import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { connect } from "./harness";

const db = "opsbridge_migrate_test";
const migratorUrl = `postgres://opsbridge_migrator:local_dev_only@127.0.0.1:54330/${db}`;
const run = (...args: string[]) =>
  execFileSync("node", ["scripts/db.mjs", ...args], {
    env: { ...process.env, DATABASE_MIGRATOR_URL: migratorUrl },
    encoding: "utf8",
  });

describe("migrations on an empty database", () => {
  let first = "";
  let second = "";
  beforeAll(() => {
    run("setup-local", db, "--recreate");
  });

  it("applies once, then finds nothing pending", () => {
    first = run("migrate");
    second = run("migrate");
    expect(first).toContain("0001_foundation.sql");
    expect(second).toContain("nothing pending");
  });

  it("no UUID is shared between workspaces", async () => {
    const c = await connect("opsbridge_migrator");
    const { rows } = await c.query(
      "SELECT id FROM app.cases GROUP BY id HAVING count(DISTINCT workspace_id) > 1",
    );
    await c.end();
    expect(rows).toEqual([]);
  });

  it("seed is idempotent", () => {
    expect(run("seed")).toEqual(run("seed"));
  });
});

describe("roles match PRD 7.4", () => {
  it("no role has elevated attributes", async () => {
    const c = await connect("opsbridge_migrator");
    const { rows } = await c.query(
      `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles
        WHERE rolname IN ('opsbridge_migrator','opsbridge_app','opsbridge_cleanup') ORDER BY 1`,
    );
    await c.end();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect([r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls]).toEqual([
        false,
        false,
        false,
        false,
      ]);
    }
  });

  it("every table is owned by the migrator, so RLS binds the runtime role", async () => {
    const c = await connect("opsbridge_migrator");
    const { rows } = await c.query(
      "SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'app'",
    );
    const noRls = await c.query(
      `SELECT relname FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace
        WHERE n.nspname = 'app' AND k.relkind = 'r' AND NOT k.relrowsecurity`,
    );
    await c.end();
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.every((r) => r.tableowner === "opsbridge_migrator")).toBe(true);
    expect(noRls.rows).toEqual([]);
  });

  it("runtime grants are exactly the documented set", async () => {
    const c = await connect("opsbridge_migrator");
    const { rows } = await c.query(
      `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'app' AND grantee IN ('opsbridge_app','opsbridge_cleanup', 'PUBLIC')
        ORDER BY 1, 2, 3`,
    );
    await c.end();
    expect(rows.map((r) => `${r.grantee}:${r.table_name}:${r.privilege_type}`)).toEqual([
      "opsbridge_app:audit_events:INSERT",
      "opsbridge_app:audit_events:SELECT",
      "opsbridge_app:cases:INSERT",
      "opsbridge_app:cases:SELECT",
      "opsbridge_app:cases:UPDATE",
      "opsbridge_app:customers:INSERT",
      "opsbridge_app:customers:SELECT",
      "opsbridge_app:customers:UPDATE",
      "opsbridge_app:workspaces:SELECT",
    ]);
  });

  it("runtime roles carry statement timeouts", async () => {
    const c = await connect("opsbridge_migrator");
    const { rows } = await c.query(
      "SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('opsbridge_app','opsbridge_cleanup') ORDER BY 1",
    );
    await c.end();
    expect(rows[0].rolconfig).toContain("statement_timeout=5s");
    expect(rows[1].rolconfig).toContain("statement_timeout=30s");
  });

  it("every definer function pins search_path", async () => {
    const c = await connect("opsbridge_migrator");
    const { rows } = await c.query(
      `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.prosecdef`,
    );
    await c.end();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) expect(r.proconfig).toContain("search_path=app, pg_temp");
  });
});
