import { beforeAll, describe, expect, it } from "vitest";
import { inWorkspaceTx, withClient } from "../../backend/src/db";
import { simulatedAdapter } from "../../backend/src/integrations/adapters";
import { commandContext } from "../../backend/src/repo/records";
import { claimRun, startRun, stepRun } from "../../backend/src/repo/sync";
import {
  baseEnv,
  call,
  connect,
  counts,
  findings,
  type Guest,
  idempotencyKey,
  launch,
  type Source,
  setRole,
  sources,
  sync,
  syncAll,
} from "./harness";

const BUSINESS = [
  "customers",
  "invoices",
  "source_records",
  "external_record_links",
  "customer_source_relationships",
  "reconciliation_findings",
  "inventory_items",
  "inventory_snapshots",
];

const fresh = async () => {
  const guest = await launch();
  await setRole(guest.cookie, "manager");
  return { guest, list: await sources(guest.cookie) };
};

const row = async (sql: string, params: unknown[]) => {
  const mig = await connect("opsbridge_migrator");
  const { rows } = await mig.query(sql, params);
  await mig.end();
  return rows;
};

describe("P3.2 ingestion", () => {
  it("P3-B: two syncs of the same snapshot add no business records", async () => {
    const { guest } = await fresh();
    const first = await syncAll(guest.cookie);
    for (const res of first) expect(res.json.status).toBe("succeeded");
    expect(first[1]?.json.counts.created).toBe(5 + 12);
    const before = await counts(guest.workspaceId, BUSINESS);
    expect(before.invoices).toBe(12);
    expect(before.source_records).toBe(3 + 5);
    const second = await syncAll(guest.cookie);
    for (const res of second) {
      expect(res.json.status).toBe("succeeded");
      expect(res.json.counts.created).toBe(0);
      expect(res.json.counts.updated).toBe(0);
      expect(res.json.counts.findings_opened).toBe(0);
    }
    expect(await counts(guest.workspaceId, BUSINESS)).toEqual(before);
    // Full replay as well as delta: reads everything again and still adds nothing.
    const list = await sources(guest.cookie);
    const full = await sync(guest.cookie, (list.erp_simulator as Source).id, { full: true });
    expect(full.json.kind).toBe("full");
    expect(full.json.counts.seen).toBe(17);
    expect(full.json.counts.unchanged).toBe(17);
    expect(await counts(guest.workspaceId, BUSINESS)).toEqual(before);
  });

  it("the second sync is a delta from the saved watermark", async () => {
    const { guest, list } = await fresh();
    const erp = (list.erp_simulator as Source).id;
    expect((await sync(guest.cookie, erp)).json.kind).toBe("full");
    const delta = await sync(guest.cookie, erp);
    expect(delta.json.kind).toBe("delta");
    expect(delta.json.counts.seen).toBeLessThan(17);
    expect(delta.json.counts.seen).toBeGreaterThan(0);
  });

  it("paginates: the ERP sync reads every page and records them", async () => {
    const { guest, list } = await fresh();
    const res = await sync(guest.cookie, (list.erp_simulator as Source).id);
    expect(res.json.pages).toBe(5);
    expect(res.json.counts.seen).toBe(17);
  });

  it("an idempotency key replays the run instead of starting another", async () => {
    const { guest, list } = await fresh();
    const headers = idempotencyKey();
    const post = () =>
      call(`/api/v1/integrations/${(list.erp_simulator as Source).id}/sync`, {
        method: "POST",
        cookie: guest.cookie,
        headers,
        body: {},
      });
    const first = await post();
    const second = await post();
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(second.json.id).toBe(first.json.id);
    const runs = await row("SELECT count(*)::int AS n FROM app.sync_runs WHERE workspace_id = $1", [
      guest.workspaceId,
    ]);
    expect(runs[0].n).toBe(1);
  });

  it("no cursor advance on failure: a page that fails in commit leaves nothing behind", async () => {
    const { guest, list } = await fresh();
    const id = (list.erp_simulator as Source).id;
    await withClient(baseEnv().HYPERDRIVE, async (db) => {
      const actor = {
        kind: "guest" as const,
        sessionId: "00000000-0000-4000-8000-00000000abcd",
        workspaceId: guest.workspaceId,
        demoRole: "manager" as const,
        expiresAt: new Date(),
        tokenHash: new Uint8Array(),
      };
      const ctx = commandContext(db, actor, "req");
      const run = await inWorkspaceTx(db, guest.workspaceId, () =>
        startRun(ctx, id, { scenario: "baseline", full: true }),
      );
      const adapter = async () =>
        simulatedAdapter("erp_simulator", {
          scenario: "baseline",
          faultsActive: false,
          shiftMs: 0,
        });
      let calls = 0;
      await expect(
        stepRun(db, ctx, run, adapter, {
          beforeCursorCommit: () => {
            if (++calls === 2) throw new Error("crash between apply and cursor");
          },
        }),
      ).rejects.toThrow("crash");
      const saved = await row(
        "SELECT cursor, pages FROM app.sync_runs WHERE workspace_id = $1 AND id = $2",
        [guest.workspaceId, run.id],
      );
      expect(saved[0].pages).toBe(1);
      expect(saved[0].cursor).toBe("erp1:customer:4");
      const records = await row(
        "SELECT count(*)::int AS n FROM app.source_records WHERE workspace_id = $1",
        [guest.workspaceId],
      );
      expect(records[0].n).toBe(4);
      await db.query("SELECT 1");
      // The lease is live, so nothing else can take the run until it lapses.
      await expect(
        inWorkspaceTx(db, guest.workspaceId, () => claimRun(ctx, id, run.id as string)),
      ).rejects.toMatchObject({ code: "sync_in_progress" });
      const mig = await connect("opsbridge_migrator");
      await mig.query(
        "UPDATE app.sync_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [run.id],
      );
      await mig.end();
      const claimed = await inWorkspaceTx(db, guest.workspaceId, () =>
        claimRun(ctx, id, run.id as string),
      );
      const done = await stepRun(db, ctx, claimed, adapter);
      expect(done.status).toBe("succeeded");
      expect((done.counts as { seen: number }).seen).toBe(17);
    });
    expect((await counts(guest.workspaceId, ["invoices"])).invoices).toBe(12);
  });

  it("a crashed run taken over counts against the resume bound; a paused one doesn't", async () => {
    const { guest, list } = await fresh();
    const id = (list.erp_simulator as Source).id;
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      `INSERT INTO app.sync_runs (workspace_id, connection_id, provider, kind, resumes, lease_token, lease_expires_at)
       VALUES ($1, $2, 'erp_simulator', 'full', 5, gen_random_uuid(), now() - interval '1 second') RETURNING id`,
      [guest.workspaceId, id],
    );
    const url = `/api/v1/integrations/${id}/runs/${rows[0].id}/resume`;
    const res = await call(url, { method: "POST", cookie: guest.cookie, body: {} });
    expect(res.json.code).toBe("retry_exhausted");
    await mig.query("UPDATE app.sync_runs SET resumes = 0, lease_token = NULL WHERE id = $1", [
      rows[0].id,
    ]);
    await mig.end();
    const ok = await call(url, { method: "POST", cookie: guest.cookie, body: {} });
    expect(ok.json.status).toBe("succeeded");
    expect(ok.json.resumes).toBe(0);
  });

  it("freshness and last success are shown after a sync, never before", async () => {
    const { guest, list } = await fresh();
    expect((list.erp_simulator as Source).freshness).toBe("never");
    await sync(guest.cookie, (list.erp_simulator as Source).id);
    const after = await sources(guest.cookie);
    expect(after.erp_simulator?.freshness).toBe("fresh");
    expect(after.erp_simulator?.lastRun.status).toBe("succeeded");
  });

  it("a second sync can't start while one is live, and an abandoned one gets closed", async () => {
    const { guest, list } = await fresh();
    const id = (list.erp_simulator as Source).id;
    const mig = await connect("opsbridge_migrator");
    await mig.query(
      `INSERT INTO app.sync_runs (workspace_id, connection_id, provider, kind, lease_expires_at)
       VALUES ($1, $2, 'erp_simulator', 'full', now() + interval '1 minute')`,
      [guest.workspaceId, id],
    );
    expect((await sync(guest.cookie, id)).json.code).toBe("sync_in_progress");
    await mig.query(
      "UPDATE app.sync_runs SET lease_expires_at = now() - interval '1 minute' WHERE workspace_id = $1",
      [guest.workspaceId],
    );
    await mig.end();
    expect((await sync(guest.cookie, id)).json.status).toBe("succeeded");
    const runs = await row(
      "SELECT status, error_code FROM app.sync_runs WHERE workspace_id = $1 ORDER BY started_at",
      [guest.workspaceId],
    );
    expect(runs[0]).toEqual({ status: "failed", error_code: "lease_expired" });
  });
});

describe("P3-E and permissions at the sync routes", () => {
  let guest: Guest;
  let list: Record<string, Source>;
  beforeAll(async () => {
    guest = await launch();
    list = await sources(guest.cookie);
  });

  it("a viewer can read integrations and can't sync", async () => {
    await setRole(guest.cookie, "viewer");
    const erp = list.erp_simulator as Source;
    expect(erp.modeLabel).toBe("Simulated");
    expect(erp.label).toBe("ERP Simulator");
    expect((await sync(guest.cookie, erp.id)).status).toBe(403);
  });

  it("an integration response carries no secret reference, cursor or token field", async () => {
    await setRole(guest.cookie, "analyst");
    await sync(guest.cookie, (list.crm_simulator as Source).id);
    const res = await call("/api/v1/integrations", { cookie: guest.cookie });
    expect(res.text).not.toMatch(/secret|token|lease|last_cursor|since_cursor/i);
  });

  it("unknown scenario and unknown fields are refused", async () => {
    const id = (list.erp_simulator as Source).id;
    expect((await sync(guest.cookie, id, { scenario: "drop_tables" })).status).toBe(400);
    expect((await sync(guest.cookie, id, { provider: "salesforce_test" })).status).toBe(400);
    expect((await sync(guest.cookie, id, { mode: "connected_test" })).status).toBe(400);
  });

  it("a scenario for another source is refused", async () => {
    const res = await sync(guest.cookie, (list.crm_simulator as Source).id, {
      scenario: "renamed_customer",
    });
    expect(res.status).toBe(400);
  });

  it("another workspace's connection looks absent", async () => {
    const other = await launch();
    await setRole(other.cookie, "manager");
    const id = (list.erp_simulator as Source).id;
    expect((await sync(other.cookie, id)).status).toBe(404);
    expect((await call(`/api/v1/integrations/${id}/runs`, { cookie: other.cookie })).status).toBe(
      404,
    );
  });

  it("the database refuses a live connection in a demo workspace", async () => {
    const mig = await connect("opsbridge_migrator");
    await expect(
      mig.query(
        `INSERT INTO app.external_connections (workspace_id, provider, mode, status)
         VALUES ($1, 'salesforce_test', 'connected_test', 'Connected Test')`,
        [guest.workspaceId],
      ),
    ).rejects.toThrow(/owner-only/);
    await expect(
      mig.query(
        "INSERT INTO app.connection_secrets (workspace_id, provider, ciphertext, iv) VALUES ($1, 'salesforce_test', 'x', decode(repeat('00', 12), 'hex'))",
        [guest.workspaceId],
      ),
    ).rejects.toThrow(/owner-only/);
    await mig.end();
  });
});

describe("P3-A evidence through replay", () => {
  it("the pack's seeded findings match what a real sync detects", async () => {
    const { guest } = await fresh();
    const before = await findings(guest.cookie);
    expect(before).toHaveLength(3);
    await syncAll(guest.cookie);
    const after = await findings(guest.cookie);
    const kinds = after.map((f) => f.kind).sort();
    for (const seeded of before) {
      expect(
        after.filter((f) => f.subject === seeded.subject && f.kind === seeded.kind),
      ).toHaveLength(1);
    }
    expect(kinds).toEqual(
      [
        "definition_conflict",
        "duplicate_client",
        "invalid_unit",
        "missing_client",
        "missing_client",
        "name_mismatch",
        "stale_snapshot",
        "unit_mismatch",
        "unknown_sku",
      ].sort(),
    );
  });

  it("seeded evidence timestamps moved with the workspace clock", async () => {
    const { guest } = await fresh();
    const [one] = await findings(guest.cookie);
    const at = Date.parse(one.evidence.sources[0].sourceTimestamp);
    expect(Math.abs(Date.now() - at)).toBeLessThan(5 * 86_400_000);
  });
});

describe("one page per request, for the Workers Free CPU limit", () => {
  const env = { SYNC_PAGES_PER_CALL: "1" };
  const post = (cookie: string, path: string) =>
    call(path, { method: "POST", cookie, env, body: {}, headers: idempotencyKey() });

  it("an analyst finishes a run by continuing it, with the same result as one call", async () => {
    const { guest, list } = await fresh();
    await setRole(guest.cookie, "analyst");
    const id = (list.erp_simulator as Source).id;
    let run = (await post(guest.cookie, `/api/v1/integrations/${id}/sync`)).json;
    let calls = 1;
    while (run.status === "running") {
      expect(run.pages).toBe(calls);
      run = (await post(guest.cookie, `/api/v1/integrations/${id}/runs/${run.id}/continue`)).json;
      calls++;
    }
    expect(calls).toBe(5);
    expect(run.status).toBe("succeeded");
    expect(run.counts.seen).toBe(17);
    expect((await counts(guest.workspaceId, ["invoices"])).invoices).toBe(12);
    expect(run.resumes).toBe(0);
  });

  it("continue can't reopen a failed run, and a finished one refuses too", async () => {
    const { guest, list } = await fresh();
    const id = (list.erp_simulator as Source).id;
    const failed = await sync(guest.cookie, id, { scenario: "http_403" });
    const res = await post(
      guest.cookie,
      `/api/v1/integrations/${id}/runs/${failed.json.id}/continue`,
    );
    expect(res.json.code).toBe("resume_required");
    const good = await sync(guest.cookie, (list.crm_simulator as Source).id);
    const done = await post(
      guest.cookie,
      `/api/v1/integrations/${(list.crm_simulator as Source).id}/runs/${good.json.id}/continue`,
    );
    expect(done.json.code).toBe("run_finished");
  });

  it("a bad page setting falls back to the default", async () => {
    const { guest, list } = await fresh();
    const res = await call(`/api/v1/integrations/${(list.erp_simulator as Source).id}/sync`, {
      method: "POST",
      cookie: guest.cookie,
      env: { SYNC_PAGES_PER_CALL: "9000" },
      headers: idempotencyKey(),
      body: {},
    });
    expect(res.json.status).toBe("succeeded");
  });
});
