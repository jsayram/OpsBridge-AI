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
    for (const role of ["opsbridge_migrator", "opsbridge_app", "opsbridge_cleanup"]) {
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

export async function seed(url) {
  const manifest = JSON.parse(readFileSync(join(root, "sample-data/seed-manifest.json"), "utf8"));
  const { customers, cases } = buildTemplate(manifest);
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
    for (const x of customers) {
      await c.query(
        `INSERT INTO app.customers (workspace_id, id, canonical_name, account_code, lifecycle_status, pack_key)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [
          TEMPLATE_WORKSPACE_ID,
          x.id,
          x.canonical_name,
          x.account_code,
          x.lifecycle_status,
          x.pack_key,
        ],
      );
    }
    for (const x of cases) {
      await c.query(
        `INSERT INTO app.cases (workspace_id, id, customer_id, title, case_type, status, due_at, pack_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
        [
          TEMPLATE_WORKSPACE_ID,
          x.id,
          x.customer_id,
          x.title,
          x.case_type,
          x.status,
          x.due_at,
          x.pack_key,
        ],
      );
    }
    await c.query(
      `INSERT INTO app.customers (workspace_id, id, canonical_name, account_code, lifecycle_status)
       VALUES ($1, $2, 'Owner sample client (fictional)', 'OWNER-1', 'Active') ON CONFLICT DO NOTHING`,
      [OWNER_WORKSPACE_ID, OWNER_CUSTOMER_ID],
    );
    await c.query(
      `INSERT INTO app.cases (workspace_id, id, customer_id, title, case_type, status)
       VALUES ($1, $2, $3, 'Owner workspace sample case', 'Onboarding', 'Draft') ON CONFLICT DO NOTHING`,
      [OWNER_WORKSPACE_ID, OWNER_CASE_ID, OWNER_CUSTOMER_ID],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
  return { customers: customers.length, cases: cases.length };
}

// Test databases only: many launches from one address, so limits are set by each test.
export async function relaxLimits(url) {
  if (!/opsbridge_(test|e2e)$/.test(url)) throw new Error("relaxLimits is for test databases");
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
