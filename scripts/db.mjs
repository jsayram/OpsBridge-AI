#!/usr/bin/env node
// Controlled database steps. Nothing runs these on Worker boot (PRD 6.3).
//   node scripts/db.mjs setup-local [dbname] [--recreate]   local only: db, roles, throwaway passwords
//   node scripts/db.mjs migrate                apply pending migrations as the migrator
//   node scripts/db.mjs seed                   idempotent template and owner workspace
//   node scripts/db.mjs status                 list applied migrations
// migrate, seed and status read DATABASE_MIGRATOR_URL.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  buildTemplate,
  loadDocumentLibrary,
  OWNER_ASSIGNEE_ID,
  OWNER_RULE_ID,
  OWNER_CASE_ID,
  OWNER_CUSTOMER_ID,
  OWNER_WORKSPACE_ID,
  TEMPLATE_WORKSPACE_ID,
} from "./lib/template-data.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = { host: "127.0.0.1", port: 54330, password: "local_dev_only" };
const LOCK = 727002;

export const localUrl = (user, db) =>
  `postgres://${user}:${LOCAL.password}@${LOCAL.host}:${LOCAL.port}/${db}`;

const connect = async (connectionString) => {
  const c = new pg.Client({ connectionString });
  await c.connect();
  return c;
};

export async function setupLocal(db, { recreate = false } = {}) {
  if (!/^opsbridge_[a-z0-9_]+$/.test(db)) throw new Error(`bad database name ${db}`);
  const admin = await connect(localUrl("opsbridge_admin", "postgres"));
  try {
    if (recreate) {
      if (!/_(test|e2e)$/.test(db)) throw new Error(`refusing to recreate ${db}`);
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    }
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [db]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${db}`);
  } finally {
    await admin.end();
  }
  const dbAdmin = await connect(localUrl("opsbridge_admin", db));
  try {
    await dbAdmin.query(readFileSync(join(root, "infra/db/bootstrap-roles.sql"), "utf8"));
    for (const role of [
      "opsbridge_migrator",
      "opsbridge_app",
      "opsbridge_cleanup",
      "opsbridge_dispatcher",
    ]) {
      await dbAdmin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${LOCAL.password}'`);
    }
  } finally {
    await dbAdmin.end();
  }
}

export async function migrate(url) {
  const c = await connect(url);
  const applied = [];
  try {
    await c.query("SELECT pg_advisory_lock($1)", [LOCK]);
    await c.query("CREATE SCHEMA IF NOT EXISTS ops");
    await c.query(`CREATE TABLE IF NOT EXISTS ops.schema_migrations (
      version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await c.query("SELECT version, sha256 FROM ops.schema_migrations")).rows.map((r) => [
        r.version,
        r.sha256,
      ]),
    );
    const dir = join(root, "backend/migrations");
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = readFileSync(join(dir, file), "utf8");
      const sha = createHash("sha256").update(sql).digest("hex");
      if (done.has(file)) {
        if (done.get(file) !== sha) throw new Error(`${file} changed after it was applied`);
        continue;
      }
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO ops.schema_migrations (version, sha256) VALUES ($1, $2)", [
          file,
          sha,
        ]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
      applied.push(file);
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
    await c.end();
  }
  return applied;
}

// One idempotent insert per table. Conflicts mean the row is already seeded, so nothing changes.
async function insertRows(c, table, workspaceId, rows) {
  for (const row of rows) {
    const cols = ["workspace_id", ...Object.keys(row)];
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    await c.query(
      `INSERT INTO app.${table} (${cols.join(", ")}) VALUES (${marks}) ON CONFLICT DO NOTHING`,
      [workspaceId, ...Object.values(row)],
    );
  }
}

export async function seed(url) {
  const manifest = JSON.parse(readFileSync(join(root, "sample-data/seed-manifest.json"), "utf8"));
  const t = buildTemplate(manifest);
  const c = await connect(url);
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO app.workspaces (id, name, mode) VALUES ($1, 'Shared template (fictional)', 'template')
       ON CONFLICT DO NOTHING`,
      [TEMPLATE_WORKSPACE_ID],
    );
    await c.query(
      `INSERT INTO app.workspaces (id, name, mode) VALUES ($1, 'Owner workspace (fictional data)', 'owner')
       ON CONFLICT DO NOTHING`,
      [OWNER_WORKSPACE_ID],
    );
    // P5.1: the shared fixture library comes first, since documents point at it. Rows are keyed
    // by fixture ID and hash, so a re-seed with the same files changes nothing.
    const library = loadDocumentLibrary();
    if (!library) throw new Error("sample-data/documents/manifest.json is missing");
    for (const d of library.documents) {
      await c.query(
        `INSERT INTO app.fixture_documents (fixture_id, title, category, kind, sha256, size, pages,
                                            text_layer, segments)
         VALUES ($1, $2, $3, $4, decode($5, 'hex'), $6, $7, $8, $9)
         ON CONFLICT (fixture_id) DO UPDATE SET title = EXCLUDED.title, category = EXCLUDED.category,
           kind = EXCLUDED.kind, sha256 = EXCLUDED.sha256, size = EXCLUDED.size,
           pages = EXCLUDED.pages, text_layer = EXCLUDED.text_layer, segments = EXCLUDED.segments`,
        [
          d.fixtureId,
          d.title,
          d.category,
          d.kind,
          d.sha256,
          d.size,
          d.pages,
          d.textLayer,
          JSON.stringify(d.segments),
        ],
      );
      await c.query(
        `INSERT INTO app.fixture_review_outputs (input_sha256, prompt_version, model_version, raw_output)
         VALUES (decode($1, 'hex'), $2, $3, $4)
         ON CONFLICT (input_sha256, prompt_version) DO UPDATE
           SET model_version = EXCLUDED.model_version, raw_output = EXCLUDED.raw_output`,
        [d.sha256, library.promptVersion, library.fixtureModel, d.fixtureOutput],
      );
    }
    const tables = [
      ["customers", t.customers],
      ["assignees", t.assignees],
      ["cases", t.cases],
      ["case_checklist_items", t.checklist],
      ["approvals", t.approvals],
      ["documents", t.documents],
      ["ai_reviews", t.ai_reviews],
      ["external_connections", t.external_connections],
      ["external_record_links", t.links],
      ["customer_source_relationships", t.relationships],
      ["reconciliation_findings", t.findings],
      ["inventory_items", t.inventory_items],
      ["inventory_snapshots", t.inventory_snapshots],
      ["workflow_rules", t.workflow_rules],
      ["invoices", t.invoices],
      ["contacts", t.contacts],
      ["source_definition_mappings", t.source_definition_mappings],
      ["outbox", t.outbox],
      ["metric_snapshots", t.metric_snapshots],
    ];
    for (const [table, rows] of tables) await insertRows(c, table, TEMPLATE_WORKSPACE_ID, rows);
    // 0008 added this key NOT VALID, before the library existed. Every row now has its fixture.
    await c.query("ALTER TABLE app.documents VALIDATE CONSTRAINT documents_fixture_fk");
    // Template documents seeded before P5 get their file's hash, size and type.
    await c.query(
      `UPDATE app.documents d SET sha256 = f.sha256, size = f.size,
              verified_type = 'application/pdf', status = 'Ready'
         FROM app.fixture_documents f
        WHERE d.workspace_id = $1 AND d.fixture_id = f.fixture_id AND d.sha256 IS NULL`,
      [TEMPLATE_WORKSPACE_ID],
    );
    // audit_events has no natural key, and its guard rightly refuses a rewrite.
    const seededAudit = await c.query(
      "SELECT 1 FROM app.audit_events WHERE workspace_id = $1 AND actor_id = 'seed' LIMIT 1",
      [TEMPLATE_WORKSPACE_ID],
    );
    if (seededAudit.rowCount === 0) {
      await insertRows(c, "audit_events", TEMPLATE_WORKSPACE_ID, t.activity);
    }
    await insertRows(c, "customers", OWNER_WORKSPACE_ID, [
      {
        id: OWNER_CUSTOMER_ID,
        canonical_name: "Owner sample client (fictional)",
        account_code: "OWNER-1",
        lifecycle_status: "Active",
      },
    ]);
    await insertRows(c, "assignees", OWNER_WORKSPACE_ID, [
      { id: OWNER_ASSIGNEE_ID, display_name: "Owner (fictional seat)", team: "Field Services" },
    ]);
    await insertRows(c, "cases", OWNER_WORKSPACE_ID, [
      {
        id: OWNER_CASE_ID,
        customer_id: OWNER_CUSTOMER_ID,
        title: "Owner workspace sample case",
        case_type: "Onboarding",
        status: "Draft",
        created_at: manifest.clock,
      },
    ]);
    await insertRows(c, "case_checklist_items", OWNER_WORKSPACE_ID, t.ownerChecklist);
    // The owner's one live-capable rule. It reaches the Sheet bridge only when that is configured;
    // until then its events finish as Simulated (P4-C Pending Owner Credentials).
    await insertRows(c, "workflow_rules", OWNER_WORKSPACE_ID, [
      {
        id: OWNER_RULE_ID,
        name: "Append approved owner cases to the test sheet",
        trigger_event: "approval.completed",
        condition: JSON.stringify({ decision: "approved" }),
        action: "sheet_append",
        updated_at: manifest.clock,
      },
    ]);
    // Simulators stay available to the owner beside any live connection. Their clock starts now.
    for (const provider of ["crm_simulator", "erp_simulator", "inventory_simulator"]) {
      await c.query(
        `INSERT INTO app.external_connections (workspace_id, provider, mode, status, scopes, simulator_shift)
         VALUES ($1, $2, 'simulated', 'Simulated', '{read}', now() - $3::timestamptz)
         ON CONFLICT DO NOTHING`,
        [OWNER_WORKSPACE_ID, provider, manifest.clock],
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
  return { customers: t.customers.length, cases: t.cases.length };
}

// Test databases only: many launches from one address, so limits are set by each test.
export async function relaxLimits(url) {
  if (!/\/opsbridge_([a-z0-9_]+_)?(test|e2e)$/.test(url))
    throw new Error("relaxLimits is for test databases");
  const c = await connect(url);
  await c.query("UPDATE app.demo_limits SET workspace_cap = 100000, hourly_limit = 100000");
  await c.end();
}

const main = async () => {
  const [cmd, arg] = process.argv.slice(2);
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (cmd === "setup-local") {
    await setupLocal(arg ?? "opsbridge_dev", { recreate: process.argv.includes("--recreate") });
    console.log(`local database ${arg ?? "opsbridge_dev"} ready`);
    return;
  }
  if (!["migrate", "seed", "status"].includes(cmd)) {
    console.error("usage: db.mjs setup-local [db] | migrate | seed | status");
    process.exit(2);
  }
  if (!url) {
    console.error("DATABASE_MIGRATOR_URL is required");
    process.exit(2);
  }
  if (cmd === "migrate")
    console.log("applied:", (await migrate(url)).join(", ") || "nothing pending");
  if (cmd === "seed") console.log("seeded:", JSON.stringify(await seed(url)));
  if (cmd === "status") {
    const c = await connect(url);
    const { rows } = await c.query(
      "SELECT version, sha256, applied_at FROM ops.schema_migrations ORDER BY 1",
    );
    for (const r of rows) console.log(r.version, r.sha256, r.applied_at.toISOString());
    await c.end();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
