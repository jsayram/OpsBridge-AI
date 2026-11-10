import { execFileSync } from "node:child_process";
import pg from "pg";
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
    expect(first).toContain("0003_core_records.sql");
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

  // The template is read-only to every runtime role, so nothing the other tests do can touch it.
  it("P2-E two clean seeds on separate databases hold identical records", async () => {
    const fresh = new pg.Client({ connectionString: migratorUrl });
    await fresh.connect();
    const main = await connect("opsbridge_migrator");
    const template = "00000000-0000-4000-8000-000000000001";
    const { rows: tables } = await fresh.query(
      `SELECT table_name,
              string_agg(column_name, ', ' ORDER BY ordinal_position)
                FILTER (WHERE table_name <> 'audit_events' OR column_name <> 'id') AS cols
         FROM information_schema.columns WHERE table_schema = 'app'
          AND table_name IN (SELECT table_name FROM information_schema.columns
                              WHERE table_schema = 'app' AND column_name = 'workspace_id')
        GROUP BY 1`,
    );
    expect(tables.length).toBeGreaterThanOrEqual(15);
    let seeded = 0;
    for (const { table_name, cols } of tables) {
      const sql = `SELECT count(*)::int AS n,
          md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS hash
        FROM (SELECT ${cols} FROM app.${table_name} WHERE workspace_id = $1) x`;
      const a = (await fresh.query(sql, [template])).rows[0];
      expect((await main.query(sql, [template])).rows[0], table_name).toEqual(a);
      seeded += a.n;
    }
    expect(seeded).toBeGreaterThan(280);
    await Promise.all([fresh.end(), main.end()]);
  });
});

describe("roles match PRD 7.4", () => {
  it("no role has elevated attributes", async () => {
    const c = await connect("opsbridge_migrator");
    const { rows } = await c.query(
      `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles
        WHERE rolname IN ('opsbridge_migrator','opsbridge_app','opsbridge_cleanup',
          'opsbridge_dispatcher') ORDER BY 1`,
    );
    await c.end();
    expect(rows).toHaveLength(4);
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
        WHERE table_schema = 'app' AND grantee IN ('opsbridge_app','opsbridge_cleanup',
          'opsbridge_dispatcher', 'PUBLIC')
        ORDER BY 1, 2, 3`,
    );
    await c.end();
    expect(rows.map((r) => `${r.grantee}:${r.table_name}:${r.privilege_type}`)).toEqual([
      "opsbridge_app:ai_reviews:INSERT",
      "opsbridge_app:ai_reviews:SELECT",
      "opsbridge_app:ai_reviews:UPDATE",
      "opsbridge_app:ai_usage:INSERT",
      "opsbridge_app:ai_usage:SELECT",
      "opsbridge_app:ai_usage:UPDATE",
      "opsbridge_app:approvals:INSERT",
      "opsbridge_app:approvals:SELECT",
      "opsbridge_app:approvals:UPDATE",
      "opsbridge_app:assignees:SELECT",
      "opsbridge_app:audit_events:INSERT",
      "opsbridge_app:audit_events:SELECT",
      "opsbridge_app:automation_control:SELECT",
      "opsbridge_app:automation_effects:SELECT",
      "opsbridge_app:case_checklist_items:INSERT",
      "opsbridge_app:case_checklist_items:SELECT",
      "opsbridge_app:case_checklist_items:UPDATE",
      "opsbridge_app:cases:INSERT",
      "opsbridge_app:cases:SELECT",
      "opsbridge_app:cases:UPDATE",
      "opsbridge_app:connection_secrets:INSERT",
      "opsbridge_app:connection_secrets:SELECT",
      "opsbridge_app:connection_secrets:UPDATE",
      "opsbridge_app:consultant_handoffs:INSERT",
      "opsbridge_app:consultant_handoffs:SELECT",
      "opsbridge_app:contacts:SELECT",
      "opsbridge_app:customer_source_relationships:INSERT",
      "opsbridge_app:customer_source_relationships:SELECT",
      "opsbridge_app:customers:INSERT",
      "opsbridge_app:customers:SELECT",
      "opsbridge_app:customers:UPDATE",
      "opsbridge_app:documents:INSERT",
      "opsbridge_app:documents:SELECT",
      "opsbridge_app:external_connections:INSERT",
      "opsbridge_app:external_connections:SELECT",
      "opsbridge_app:external_connections:UPDATE",
      "opsbridge_app:external_record_links:INSERT",
      "opsbridge_app:external_record_links:SELECT",
      "opsbridge_app:external_record_links:UPDATE",
      "opsbridge_app:fixture_documents:SELECT",
      "opsbridge_app:fixture_review_outputs:SELECT",
      "opsbridge_app:idempotency_keys:INSERT",
      "opsbridge_app:idempotency_keys:SELECT",
      "opsbridge_app:idempotency_keys:UPDATE",
      "opsbridge_app:inventory_items:SELECT",
      "opsbridge_app:inventory_snapshots:INSERT",
      "opsbridge_app:inventory_snapshots:SELECT",
      "opsbridge_app:invoices:INSERT",
      "opsbridge_app:invoices:SELECT",
      "opsbridge_app:invoices:UPDATE",
      "opsbridge_app:metric_snapshots:INSERT",
      "opsbridge_app:metric_snapshots:SELECT",
      "opsbridge_app:metric_snapshots:UPDATE",
      "opsbridge_app:oauth_states:INSERT",
      "opsbridge_app:oauth_states:SELECT",
      "opsbridge_app:oauth_states:UPDATE",
      "opsbridge_app:outbox:INSERT",
      "opsbridge_app:outbox:SELECT",
      "opsbridge_app:outbox_attempts:SELECT",
      "opsbridge_app:reconciliation_findings:INSERT",
      "opsbridge_app:reconciliation_findings:SELECT",
      "opsbridge_app:reconciliation_findings:UPDATE",
      "opsbridge_app:source_definition_mappings:INSERT",
      "opsbridge_app:source_definition_mappings:SELECT",
      "opsbridge_app:source_records:INSERT",
      "opsbridge_app:source_records:SELECT",
      "opsbridge_app:source_records:UPDATE",
      "opsbridge_app:sync_runs:INSERT",
      "opsbridge_app:sync_runs:SELECT",
      "opsbridge_app:sync_runs:UPDATE",
      "opsbridge_app:workflow_rules:INSERT",
      "opsbridge_app:workflow_rules:SELECT",
      "opsbridge_app:workflow_rules:UPDATE",
      "opsbridge_app:workspaces:SELECT",
      "opsbridge_dispatcher:workflow_rules:SELECT",
    ]);
  });

  it("runtime roles carry statement timeouts", async () => {
    const c = await connect("opsbridge_migrator");
    const { rows } = await c.query(
      "SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('opsbridge_app','opsbridge_cleanup','opsbridge_dispatcher') ORDER BY 1",
    );
    await c.end();
    expect(rows[0].rolconfig).toContain("statement_timeout=5s");
    expect(rows[1].rolconfig).toContain("statement_timeout=30s");
    expect(rows[2].rolconfig).toContain("statement_timeout=5s");
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

// P7.3: an upgrade one migration at a time ends in the same schema as a fresh install, and the
// dispatcher change follows expand-then-contract so the previous Worker survives a rollback.
describe("upgrade path and rollback compatibility (P7.3)", () => {
  const up = "opsbridge_upgrade_test";
  const upUrl = `postgres://opsbridge_migrator:local_dev_only@127.0.0.1:54330/${up}`;
  const runUp = (...args: string[]) =>
    execFileSync("node", ["scripts/db.mjs", ...args], {
      env: { ...process.env, DATABASE_MIGRATOR_URL: upUrl },
      encoding: "utf8",
    });
  const versions = execFileSync("ls", ["backend/migrations"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.slice(0, 4));
  const canDispatch = async (url: string, role: string) => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const { rows } = await c.query(
      "SELECT has_function_privilege($1, 'app.claim_due_outbox(int, uuid)', 'EXECUTE') AS ok",
      [role],
    );
    await c.end();
    return rows[0].ok as boolean;
  };
  const schema = async (url: string) => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const out: Record<string, string> = {};
    for (const [name, sql] of Object.entries({
      columns: `SELECT string_agg(table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,''), ',' ORDER BY table_name, column_name) AS v FROM information_schema.columns WHERE table_schema IN ('app','ops')`,
      constraints: `SELECT string_agg(conrelid::regclass||'.'||conname||':'||pg_get_constraintdef(oid), ',' ORDER BY conrelid::regclass::text, conname) AS v FROM pg_constraint WHERE connamespace = 'app'::regnamespace`,
      indexes: `SELECT string_agg(indexdef, ',' ORDER BY indexdef) AS v FROM pg_indexes WHERE schemaname = 'app'`,
      policies: `SELECT string_agg(tablename||'.'||policyname||':'||array_to_string(roles, '+')||':'||coalesce(qual,'')||':'||coalesce(with_check,''), ',' ORDER BY tablename, policyname) AS v FROM pg_policies WHERE schemaname = 'app'`,
      grants: `SELECT string_agg(grantee||':'||table_name||':'||privilege_type, ',' ORDER BY grantee, table_name, privilege_type) AS v FROM information_schema.role_table_grants WHERE table_schema = 'app' AND grantee LIKE 'opsbridge%'`,
      functions: `SELECT string_agg(p.oid::regprocedure||':'||md5(p.prosrc)||':'||coalesce(array_to_string(p.proacl, '+'),''), ',' ORDER BY p.oid::regprocedure::text) AS v FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace`,
      triggers: `SELECT string_agg(tgrelid::regclass||'.'||tgname, ',' ORDER BY tgrelid::regclass::text, tgname) AS v FROM pg_trigger WHERE NOT tgisinternal`,
    })) {
      out[name] = (await c.query(sql)).rows[0].v;
    }
    await c.end();
    return out;
  };

  it("stepping through every migration matches a fresh install exactly", async () => {
    runUp("setup-local", up, "--recreate");
    for (const v of versions) expect(runUp("migrate", "--to", v)).toContain(`${v}_`);
    expect(runUp("migrate")).toContain("nothing pending");
    // A release always seeds after migrating, and the seed validates the fixture key added
    // NOT VALID in 0008, so both sides are compared after their seed.
    runUp("seed");
    expect(await schema(upUrl)).toEqual(await schema(migratorUrl));
  });

  it("0010 alone keeps the request role able to dispatch, so the previous Worker still works", async () => {
    runUp("setup-local", up, "--recreate");
    runUp("migrate", "--to", "0010");
    expect(await canDispatch(upUrl, "opsbridge_app")).toBe(true);
    expect(await canDispatch(upUrl, "opsbridge_dispatcher")).toBe(true);
    runUp("migrate");
    expect(await canDispatch(upUrl, "opsbridge_app")).toBe(false);
    expect(await canDispatch(upUrl, "opsbridge_dispatcher")).toBe(true);
  });

  it("--to refuses a value that isn't a migration number", () => {
    expect(() => runUp("migrate", "--to", "latest")).toThrow();
  });
});
