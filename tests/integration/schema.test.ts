import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  call,
  connect,
  counts,
  type Guest,
  idempotencyKey,
  launch,
  packCases,
  setRole,
  withLimits,
} from "./harness";

const manifest = JSON.parse(readFileSync("sample-data/seed-manifest.json", "utf8"));
const TEMPLATE = "00000000-0000-4000-8000-000000000001";
const OTHER_UUID = "11111111-1111-4111-8111-111111111111";

const inWorkspace = async (ws: string, fn: (c: Awaited<ReturnType<typeof connect>>) => unknown) => {
  const c = await connect("opsbridge_app");
  await c.query("BEGIN");
  await c.query("SELECT set_config('app.workspace_id', $1, true)", [ws]);
  try {
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
};

const fails = async (run: () => unknown, pattern: RegExp) => {
  await expect(Promise.resolve().then(run)).rejects.toThrow(pattern);
};

describe("P2.1 schema", () => {
  let A: Guest;
  let B: Guest;
  let aCase: string;
  let bCustomer: string;

  beforeAll(async () => {
    A = await launch();
    B = await launch();
    const mig = await connect("opsbridge_migrator");
    aCase = (
      await mig.query("SELECT id FROM app.cases WHERE workspace_id = $1 LIMIT 1", [A.workspaceId])
    ).rows[0].id;
    bCustomer = (
      await mig.query("SELECT id FROM app.customers WHERE workspace_id = $1 LIMIT 1", [
        B.workspaceId,
      ])
    ).rows[0].id;
    await mig.end();
  });

  it("every business table has RLS on and a workspace_id column", async () => {
    const c = await connect("opsbridge_migrator");
    const { rows } = await c.query(
      `SELECT k.relname, k.relrowsecurity,
              EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid = k.oid
                      AND a.attname = 'workspace_id' AND NOT a.attisdropped) AS scoped
         FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace
        WHERE n.nspname = 'app' AND k.relkind = 'r'`,
    );
    await c.end();
    const unscoped = rows.filter((r) => !r.scoped).map((r) => r.relname);
    expect(unscoped.sort()).toEqual([
      "automation_control",
      "demo_limits",
      "demo_quota",
      // P5: the shared, read-only fixture library. Same 40 fictional documents for everyone.
      "fixture_documents",
      "fixture_review_outputs",
      "users",
      "workspaces",
    ]);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it("composite keys stop a row pointing across workspaces", async () => {
    const mig = await connect("opsbridge_migrator");
    const refused = /foreign key/;
    await fails(
      () =>
        mig.query(
          `INSERT INTO app.cases (workspace_id, customer_id, title, case_type) VALUES ($1, $2, 'x', 'Billing')`,
          [A.workspaceId, bCustomer],
        ),
      refused,
    );
    await fails(
      () =>
        mig.query(
          "INSERT INTO app.approvals (workspace_id, case_id, proposed_action, requested_by) VALUES ($1, $2, 'approve_case', 'x')",
          [B.workspaceId, aCase],
        ),
      refused,
    );
    await fails(
      () =>
        mig.query(
          "INSERT INTO app.case_checklist_items (workspace_id, case_id, item_key, label) VALUES ($1, $2, 'k', 'x')",
          [B.workspaceId, aCase],
        ),
      refused,
    );
    await fails(
      () =>
        mig.query(
          "INSERT INTO app.documents (workspace_id, case_id, title, fixture_id) VALUES ($1, $2, 'x', 'fx-a')",
          [B.workspaceId, aCase],
        ),
      refused,
    );
    await fails(
      () => mig.query("UPDATE app.cases SET assignee_id = $1 WHERE id = $2", [OTHER_UUID, aCase]),
      refused,
    );
    await mig.end();
  });

  it("constraints reject bad vocabulary and impossible rows", async () => {
    const mig = await connect("opsbridge_migrator");
    const ws = A.workspaceId;
    const doc = (extra: string) =>
      `INSERT INTO app.documents (workspace_id, case_id, title, ${extra})`;
    await fails(
      () =>
        mig.query(`${doc("fixture_id, object_key")} VALUES ($1, $2, 'x', 'fx-a', 'k')`, [
          ws,
          aCase,
        ]),
      /documents_check/,
    );
    await fails(
      () => mig.query(`${doc("status")} VALUES ($1, $2, 'x', 'Ready')`, [ws, aCase]),
      /documents_check/,
    );
    await fails(
      () => mig.query(`${doc("fixture_id")} VALUES ($1, $2, 'x', '../etc')`, [ws, aCase]),
      /fixture_id_check/,
    );
    await fails(
      () =>
        mig.query(
          "INSERT INTO app.outbox (workspace_id, event_type, payload_ref, payload, idempotency_key) VALUES ($1, 'made.up', 'r', '{}', 'k')",
          [ws],
        ),
      /event_type_check/,
    );
    await fails(
      () =>
        mig.query(
          "INSERT INTO app.outbox (workspace_id, event_type, payload_ref, payload, idempotency_key, delivery_evidence) VALUES ($1, 'case.created', 'r', '{}', 'k', 'confirmed')",
          [ws],
        ),
      /outbox_check/,
    );
    await fails(
      () =>
        mig.query(
          "INSERT INTO app.reconciliation_findings (workspace_id, entity_type, entity_id, kind, severity, source_values, status) VALUES ($1, 'customer', $2, 'k', 'low', '{}', 'Deferred')",
          [ws, OTHER_UUID],
        ),
      /reconciliation_findings_check/,
    );
    await fails(
      () =>
        mig.query(
          "INSERT INTO app.inventory_snapshots (workspace_id, provider, external_id, quantity, unit, source_version, observed_at) VALUES ($1, 'inventory_simulator', 'x', 1, 'each', 1, now())",
          [ws],
        ),
      /inventory_snapshots_check/,
    );
    await mig.end();
  });

  it("duplicates are refused where one business fact must stay one row", async () => {
    const mig = await connect("opsbridge_migrator");
    const ws = A.workspaceId;
    const outbox = (key: string) =>
      mig.query(
        "INSERT INTO app.outbox (workspace_id, event_type, payload_ref, payload, idempotency_key) VALUES ($1, 'case.created', 'r', '{}', $2)",
        [ws, key],
      );
    await outbox("once");
    await fails(() => outbox("once"), /duplicate key/);
    const approval = () =>
      mig.query(
        "INSERT INTO app.approvals (workspace_id, case_id, proposed_action, requested_by) VALUES ($1, $2, 'approve_case', 'x')",
        [ws, aCase],
      );
    const existing = await mig.query(
      "SELECT count(*)::int AS n FROM app.approvals WHERE workspace_id = $1 AND case_id = $2 AND status = 'pending'",
      [ws, aCase],
    );
    if (existing.rows[0].n === 0) await approval();
    await fails(approval, /approvals_one_pending/);
    const link = () =>
      mig.query(
        "INSERT INTO app.external_record_links (workspace_id, provider, external_type, external_id, canonical_type, canonical_id, last_seen) VALUES ($1, 'crm_simulator', 'organization', 'CRM-ORG-1001', 'customer', $2, now())",
        [ws, OTHER_UUID],
      );
    await fails(link, /duplicate key/);
    await mig.end();
  });

  it("runtime role can't write the template, another workspace, or history tables", async () => {
    await inWorkspace(A.workspaceId, async (c) => {
      const rows = await c.query(
        "SELECT count(*)::int AS n FROM app.approvals WHERE workspace_id = $1",
        [B.workspaceId],
      );
      expect(rows.rows[0].n).toBe(0);
    });
    await inWorkspace(A.workspaceId, (c) =>
      fails(
        () =>
          c.query(
            "INSERT INTO app.case_checklist_items (workspace_id, case_id, item_key, label) SELECT $1, id, 'k', 'x' FROM app.cases WHERE workspace_id = $1 LIMIT 1",
            [TEMPLATE],
          ),
        /row-level security/,
      ),
    );
    await inWorkspace(TEMPLATE, (c) =>
      fails(
        () =>
          c.query(
            "INSERT INTO app.outbox (workspace_id, event_type, payload_ref, payload, idempotency_key) VALUES ($1, 'case.created', 'r', '{}', 'k')",
            [TEMPLATE],
          ),
        /row-level security/,
      ),
    );
    for (const sql of [
      "UPDATE app.outbox SET dispatch_state = 'accepted'",
      "UPDATE app.consultant_handoffs SET reason = 'x'",
      "DELETE FROM app.approvals",
      "DELETE FROM app.idempotency_keys",
      "UPDATE app.documents SET title = 'x'",
      "DELETE FROM app.ai_reviews",
    ]) {
      await inWorkspace(A.workspaceId, (c) => fails(() => c.query(sql), /permission denied/));
    }
    // P5 grants UPDATE on reviews for status and decisions; the stored suggestion stays fixed.
    await inWorkspace(A.workspaceId, (c) =>
      fails(
        () => c.query("UPDATE app.ai_reviews SET extraction = '{}'"),
        /ai_suggestion_immutable/,
      ),
    );
  });

  it("the pack holds every manifest table, and two launches match", async () => {
    const first = await launch();
    const second = await launch();
    const mig = await connect("opsbridge_migrator");
    const logical: Record<string, string> = {
      customers: "canonical_name, account_code",
      assignees: "display_name, team, can_receive_cases",
      cases: "title, status, queue, pack_key",
      case_checklist_items: "item_key, state, required",
      documents: "title, fixture_id, status",
      ai_reviews: "status, extraction::text",
      approvals: "status, proposed_action",
      external_record_links: "provider, external_id",
      customer_source_relationships: "relationship_role, mapping_version",
      reconciliation_findings: "kind, status, severity",
      inventory_items: "canonical_item_code",
      inventory_snapshots: "external_id, source_version, quantity",
      workflow_rules: "name, trigger_event",
      external_connections: "provider, mode, status",
    };
    let total = 0;
    for (const [table, count] of Object.entries(manifest.scenarioPack.rows) as [string, number][]) {
      const q = `SELECT ${logical[table]} FROM app.${table} WHERE workspace_id = $1`;
      const sorted = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
      const a = sorted((await mig.query(q, [first.workspaceId])).rows);
      const b = sorted((await mig.query(q, [second.workspaceId])).rows);
      expect(b, table).toEqual(a);
      expect(a.length, table).toBe(count);
      total += count;
    }
    expect(total).toBeGreaterThanOrEqual(30);
    expect(total).toBeLessThanOrEqual(40);
    await mig.end();
  });

  it("a purge leaves no row in any workspace-scoped table", async () => {
    const victim = await launch();
    await setRole(victim.cookie, "manager");
    const pack = await packCases(victim);
    const customers = await call("/api/v1/customers", { cookie: victim.cookie });
    await call("/api/v1/cases", {
      method: "POST",
      cookie: victim.cookie,
      headers: idempotencyKey(),
      body: { title: "x", customerId: customers.json.items[0].id, caseType: "Billing" },
    });
    await call(`/api/v1/cases/${pack["case-1"]?.id}/handoffs`, {
      method: "POST",
      cookie: victim.cookie,
      body: { toQueue: "Seasonal Staffing", reason: "x", expectedCaseVersion: 1 },
    });
    const sources = await call("/api/v1/integrations", { cookie: victim.cookie });
    for (const source of sources.json.items) {
      await call(`/api/v1/integrations/${source.id}/sync`, {
        method: "POST",
        cookie: victim.cookie,
        headers: idempotencyKey(),
        body: {},
      });
    }
    const ready = await call(`/api/v1/cases/${pack["case-3"]?.id}`, { cookie: victim.cookie });
    await call(`/api/v1/approvals/${ready.json.approval.id}/decision`, {
      method: "POST",
      cookie: victim.cookie,
      headers: idempotencyKey(),
      body: { decision: "approve", caseVersion: 1 },
    });
    const filled = await counts(victim.workspaceId, [
      "consultant_handoffs",
      "outbox",
      "idempotency_keys",
      "sync_runs",
      "source_records",
      "invoices",
      "reconciliation_findings",
    ]);
    for (const [table, n] of Object.entries(filled)) expect(n, table).toBeGreaterThan(0);
    const mig = await connect("opsbridge_migrator");
    const clean = await connect("opsbridge_cleanup");
    await mig.query(
      "UPDATE app.workspaces SET expires_at = now() - interval '5 minutes' WHERE id = $1",
      [victim.workspaceId],
    );
    await clean.query("SELECT app.purge_demo_workspace($1)", [victim.workspaceId]);
    const { rows: tables } = await mig.query(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'app' AND column_name = 'workspace_id'",
    );
    expect(tables.length).toBeGreaterThanOrEqual(20);
    for (const { table_name } of tables) {
      if (table_name === "retention_log") continue;
      const left = await mig.query(
        `SELECT count(*)::int AS n FROM app.${table_name} WHERE workspace_id = $1`,
        [victim.workspaceId],
      );
      expect(left.rows[0].n, table_name).toBe(0);
    }
    await Promise.all([mig.end(), clean.end()]);
  });

  it("the sweep removes idempotency keys after 24 hours and keeps newer ones", async () => {
    const mig = await connect("opsbridge_migrator");
    const hash = Buffer.alloc(32, 7);
    const insert = (key: string, age: string) =>
      mig.query(
        `INSERT INTO app.idempotency_keys (workspace_id, key, request_hash, created_at) VALUES ($1, $2, $3, now() - $4::interval)`,
        [A.workspaceId, key, hash, age],
      );
    await insert("expired-key", "25 hours");
    await insert("current-key", "23 hours");
    const clean = await connect("opsbridge_cleanup");
    const { rows } = await clean.query("SELECT app.purge_expired_idempotency_keys() AS n");
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
    const left = await mig.query(
      "SELECT key FROM app.idempotency_keys WHERE workspace_id = $1 AND key IN ('expired-key', 'current-key')",
      [A.workspaceId],
    );
    expect(left.rows).toEqual([{ key: "current-key" }]);
    await Promise.all([mig.end(), clean.end()]);
  });

  it("a demo workspace stops accepting writes at the cap, and the limit is migrator-only", async () => {
    const g = await launch();
    await withLimits({ write_cap: 2 }, async () => {
      const c = await call("/api/v1/cases?limit=1", { cookie: g.cookie });
      const target = c.json.items[0];
      const first = await call(`/api/v1/cases/${target.id}`, {
        method: "PATCH",
        cookie: g.cookie,
        body: { title: "One", version: target.version },
      });
      expect(first.status).toBe(200);
      const over = await call(`/api/v1/cases/${target.id}`, {
        method: "PATCH",
        cookie: g.cookie,
        body: { title: "Two", version: target.version + 1 },
      });
      expect(over.status).toBe(429);
      expect(over.json.code).toBe("demo_write_limit");
    });
    await inWorkspace(g.workspaceId, (c) =>
      fails(() => c.query("UPDATE app.demo_limits SET write_cap = 99999"), /permission denied/),
    );
  });
});
