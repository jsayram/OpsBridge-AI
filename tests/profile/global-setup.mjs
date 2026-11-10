import { readFileSync } from "node:fs";
import pg from "pg";
import { localUrl, migrate, relaxLimits, seed, setupLocal } from "../../scripts/db.mjs";
import {
  buildProfile,
  OWNER_ASSIGNEE_ID,
  OWNER_CUSTOMER_ID,
  OWNER_WORKSPACE_ID,
} from "../../scripts/lib/template-data.mjs";

const DB = "opsbridge_profile_test";

export default async function setup() {
  await setupLocal(DB, { recreate: true });
  const url = localUrl("opsbridge_migrator", DB);
  await migrate(url);
  await seed(url);
  await relaxLimits(url);
  const manifest = JSON.parse(readFileSync("sample-data/seed-manifest.json", "utf8"));
  const rows = buildProfile(manifest, OWNER_CUSTOMER_ID, OWNER_ASSIGNEE_ID);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("BEGIN");
  for (const r of rows) {
    await c.query(
      `INSERT INTO app.cases (workspace_id, id, customer_id, title, case_type, status, due_at, created_at, assignee_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        OWNER_WORKSPACE_ID,
        r.id,
        r.customer_id,
        r.title,
        r.case_type,
        r.status,
        r.due_at,
        r.created_at,
        r.assignee_id,
      ],
    );
    for (let i = 0; i < manifest.profile.auditRowsPerCase; i++) {
      await c.query(
        `INSERT INTO app.audit_events (workspace_id, actor_type, actor_id, actor_role, action, target, summary)
         VALUES ($1, 'system', 'profile', 'system', 'case.updated', $2, 'Profile row (synthetic)')`,
        [OWNER_WORKSPACE_ID, r.id],
      );
    }
  }
  await c.query("COMMIT");
  await c.query("ANALYZE");
  await c.end();
}
