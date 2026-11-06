import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Guest, launch } from "./harness";

// The P0 proof checks P3.a to P3.u, repeated against the real migrations. Checks on
// approvals and outbox wait for those tables (P2.4, P4.2).
const denied = async (fn: () => Promise<unknown>, pattern: RegExp) => {
  await expect(fn()).rejects.toThrow(pattern);
};

describe("isolation and least privilege", () => {
  let app_: pg.Client;
  let clean: pg.Client;
  let mig: pg.Client;
  let A: Guest;
  let B: Guest;
  let ownerWs: string;
  let templateWs: string;
  let ownerCase: string;
  const inWs = async <T>(ws: string, fn: () => Promise<T>) => {
    await app_.query("BEGIN");
    await app_.query("SELECT set_config('app.workspace_id', $1, true)", [ws]);
    try {
      const r = await fn();
      await app_.query("COMMIT");
      return r;
    } catch (e) {
      await app_.query("ROLLBACK");
      throw e;
    }
  };

  beforeAll(async () => {
    app_ = await connect("opsbridge_app");
    clean = await connect("opsbridge_cleanup");
    mig = await connect("opsbridge_migrator");
    A = await launch();
    B = await launch();
    ownerWs = (await mig.query("SELECT id FROM app.workspaces WHERE mode = 'owner'")).rows[0].id;
    templateWs = (await mig.query("SELECT id FROM app.workspaces WHERE mode = 'template'")).rows[0]
      .id;
    ownerCase = (await mig.query("SELECT id FROM app.cases WHERE workspace_id = $1", [ownerWs]))
      .rows[0].id;
  });
  afterAll(async () => {
    await Promise.all([app_.end(), clean.end(), mig.end()]);
  });

  it("P3.a no workspace set returns only template rows", async () => {
    const { rows } = await app_.query("SELECT DISTINCT workspace_id FROM app.cases");
    expect(rows).toEqual([{ workspace_id: templateWs }]);
  });
  it("P3.b A cannot read B or owner by id", async () => {
    const r = await inWs(A.workspaceId, () =>
      app_.query("SELECT * FROM app.cases WHERE id = ANY($1)", [[B.caseId, ownerCase]]),
    );
    expect(r.rows.filter((x) => x.workspace_id !== templateWs)).toEqual([]);
  });
  it("P3.c A cannot update B or the template", async () => {
    const r = await inWs(A.workspaceId, () =>
      app_.query("UPDATE app.cases SET title = 'x' WHERE workspace_id = ANY($1)", [
        [B.workspaceId, templateWs],
      ]),
    );
    expect(r.rowCount).toBe(0);
  });
  it("P3.d A cannot insert into B", async () => {
    await denied(
      () =>
        inWs(A.workspaceId, () =>
          app_.query(
            "INSERT INTO app.customers (workspace_id, canonical_name, account_code, lifecycle_status) VALUES ($1, 'x', 'x', 'Active')",
            [B.workspaceId],
          ),
        ),
      /row-level security/,
    );
  });
  it("composite FK blocks a case that points across workspaces", async () => {
    const other = (
      await mig.query("SELECT id FROM app.customers WHERE workspace_id = $1", [B.workspaceId])
    ).rows[0].id;
    await denied(
      () =>
        inWs(A.workspaceId, () =>
          app_.query(
            "INSERT INTO app.cases (workspace_id, customer_id, title, case_type) VALUES ($1, $2, 'x', 'Billing')",
            [A.workspaceId, other],
          ),
        ),
      /foreign key/,
    );
  });
  it("P3.e set_config does not survive COMMIT on a reused connection", async () => {
    await inWs(A.workspaceId, async () => {});
    const { rows } = await app_.query("SELECT app.current_workspace() AS w");
    expect(rows[0].w).toBeNull();
  });
  it("P3.f-i runtime role has no destructive rights", async () => {
    await denied(
      () => inWs(A.workspaceId, () => app_.query("DELETE FROM app.cases")),
      /permission denied/,
    );
    await denied(
      () => inWs(A.workspaceId, () => app_.query("DELETE FROM app.audit_events")),
      /permission denied/,
    );
    await denied(
      () => inWs(A.workspaceId, () => app_.query("UPDATE app.audit_events SET action = 'x'")),
      /permission denied/,
    );
    await denied(() => app_.query("TRUNCATE app.audit_events"), /permission denied/);
  });
  it("P3.j runtime role cannot run purge, seed or workspace creation", async () => {
    await denied(
      () => app_.query("SELECT app.purge_demo_workspace($1)", [A.workspaceId]),
      /permission denied/,
    );
    await denied(
      () => app_.query("SELECT app.seed_demo_workspace($1)", [A.workspaceId]),
      /permission denied/,
    );
    await denied(() => app_.query("SELECT app.create_demo_workspace()"), /permission denied/);
    await denied(
      () => app_.query("SELECT app.take_workspace_quota($1)", [Buffer.alloc(32)]),
      /permission denied/,
    );
  });
  it("runtime role cannot read token hashes, quota, users or memberships", async () => {
    for (const t of ["demo_sessions", "demo_quota", "users", "memberships", "retention_log"]) {
      await denied(() => app_.query(`SELECT * FROM app.${t}`), /permission denied/);
    }
  });
  it("P3.k-m even the table owner cannot alter audit rows", async () => {
    await denied(
      () =>
        mig.query("UPDATE app.audit_events SET action = 'x' WHERE workspace_id = $1", [
          A.workspaceId,
        ]),
      /append-only/,
    );
    await denied(
      () => mig.query("DELETE FROM app.audit_events WHERE workspace_id = $1", [A.workspaceId]),
      /append-only/,
    );
    await denied(() => mig.query("TRUNCATE app.audit_events"), /append-only/);
  });
  it("P3.n-q cleanup role has no table rights and can't purge unexpired work", async () => {
    await denied(
      () => clean.query("UPDATE app.audit_events SET action = 'x'"),
      /permission denied/,
    );
    await denied(() => clean.query("SELECT 1 FROM app.cases"), /permission denied/);
    await denied(() => clean.query("DELETE FROM app.audit_events"), /permission denied/);
    await denied(() => clean.query("DELETE FROM app.cases"), /permission denied/);
    await denied(
      () => clean.query("SELECT app.purge_demo_workspace($1)", [A.workspaceId]),
      /refusing to purge/,
    );
  });
  it("P3.r cleanup cannot purge owner or template workspaces", async () => {
    await denied(
      () => clean.query("SELECT app.purge_demo_workspace($1)", [ownerWs]),
      /refusing to purge/,
    );
    await denied(
      () => clean.query("SELECT app.purge_demo_workspace($1)", [templateWs]),
      /refusing to purge/,
    );
  });
  it("P3.s2-s3 runtime cannot flip a workspace or create one directly", async () => {
    await denied(
      () =>
        inWs(ownerWs, () =>
          app_.query("UPDATE app.workspaces SET mode = 'demo', expires_at = now() WHERE id = $1", [
            ownerWs,
          ]),
        ),
      /permission denied/,
    );
    await denied(
      () => app_.query("INSERT INTO app.workspaces (name, mode) VALUES ('x', 'owner')"),
      /permission denied/,
    );
  });
  it("P3.s4 A cannot see B or owner in workspaces", async () => {
    const r = await inWs(A.workspaceId, () =>
      app_.query("SELECT id FROM app.workspaces WHERE id = ANY($1)", [[B.workspaceId, ownerWs]]),
    );
    expect(r.rowCount).toBe(0);
  });
  it("template stays read-only even if a bug sets it as the current workspace", async () => {
    const r = await inWs(templateWs, () =>
      app_.query("UPDATE app.cases SET title = 'x' WHERE workspace_id = $1", [templateWs]),
    );
    expect(r.rowCount).toBe(0);
    await denied(
      () =>
        inWs(templateWs, () =>
          app_.query(
            "INSERT INTO app.audit_events (workspace_id, actor_type, actor_id, action, target) VALUES ($1, 'system', 'x', 'x', 'x')",
            [templateWs],
          ),
        ),
      /row-level security/,
    );
  });
  it("even the migrator can't delete audit rows of an expired demo workspace", async () => {
    const victim = await launch();
    await mig.query(
      "UPDATE app.workspaces SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [victim.workspaceId],
    );
    await denied(
      () => mig.query("DELETE FROM app.audit_events WHERE workspace_id = $1", [victim.workspaceId]),
      /append-only/,
    );
  });
  it("P3.t0-u purge lists and removes only expired demo data, with a retention record", async () => {
    const victim = await launch();
    await mig.query(
      "UPDATE app.workspaces SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [victim.workspaceId],
    );
    const listed = (await clean.query("SELECT * FROM app.expired_demo_workspaces(5)")).rows.map(
      (r) => r.expired_demo_workspaces,
    );
    expect(listed).toContain(victim.workspaceId);
    expect(listed).not.toContain(ownerWs);
    expect(listed).not.toContain(B.workspaceId);
    await clean.query("SELECT app.purge_demo_workspace($1)", [victim.workspaceId]);
    for (const t of ["audit_events", "cases", "customers", "demo_sessions"]) {
      const { rows } = await mig.query(
        `SELECT count(*)::int AS n FROM app.${t} WHERE workspace_id = $1`,
        [victim.workspaceId],
      );
      expect(rows[0].n).toBe(0);
    }
    const rl = await mig.query(
      "SELECT audit_rows, business_rows FROM app.retention_log WHERE workspace_id = $1",
      [victim.workspaceId],
    );
    expect(rl.rows[0]).toEqual({ audit_rows: 1, business_rows: 39 });
    const survivors = await mig.query(
      "SELECT count(*)::int AS n FROM app.cases WHERE workspace_id = $1",
      [B.workspaceId],
    );
    expect(survivors.rows[0].n).toBe(3);
  });
});
