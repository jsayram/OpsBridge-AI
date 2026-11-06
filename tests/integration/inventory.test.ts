import { describe, expect, it } from "vitest";
import {
  call,
  connect,
  counts,
  findings,
  launch,
  packCases,
  type Source,
  setRole,
  sources,
  sync,
} from "./harness";

const fresh = async () => {
  const guest = await launch();
  await setRole(guest.cookie, "manager");
  const list = await sources(guest.cookie);
  return { guest, list, id: (list.inventory_simulator as Source).id };
};
const quantities = async (workspaceId: string) => {
  const mig = await connect("opsbridge_migrator");
  const { rows } = await mig.query(
    "SELECT external_id, source_version, quantity::text, unit FROM app.inventory_snapshots WHERE workspace_id = $1 ORDER BY 1, 2",
    [workspaceId],
  );
  await mig.end();
  return rows;
};

describe("P3.5 inventory slice (P3-G, JOB-TEST-03)", () => {
  it("paginates, opens one finding per problem, and invents no item", async () => {
    const { guest, id } = await fresh();
    const res = await sync(guest.cookie, id);
    expect(res.json.status).toBe("succeeded");
    expect(res.json.pages).toBe(3);
    expect(res.json.counts.seen).toBe(7);
    const kinds = (await findings(guest.cookie)).map((f) => f.kind);
    for (const k of ["unknown_sku", "unit_mismatch", "invalid_unit", "stale_snapshot"]) {
      expect(kinds).toContain(k);
    }
    expect((await counts(guest.workspaceId, ["inventory_items"])).inventory_items).toBe(3);
    const view = await call("/api/v1/inventory", { cookie: guest.cookie });
    expect(view.json.sourceLabel).toBe("Simulated");
    expect(view.json.unresolved.map((u: any) => u.itemCode)).toEqual(["SKU-998"]);
  });

  it("evidence keeps the source facts and freshness", async () => {
    const { guest, id } = await fresh();
    await sync(guest.cookie, id);
    const f = (await findings(guest.cookie)).find((x) => x.kind === "unit_mismatch");
    expect(f.evidence.sources[0].fields).toMatchObject({
      itemCode: "SKU-101",
      quantity: "40",
      unit: "each",
    });
    expect(f.evidence.differences[0].values).toEqual({ canonical: "box", source: "each" });
    expect(Date.parse(f.evidence.sources[0].sourceTimestamp)).not.toBeNaN();
  });

  it("replay changes no quantity and adds no row, and approving changes no quantity", async () => {
    const { guest, id } = await fresh();
    await sync(guest.cookie, id);
    const before = await quantities(guest.workspaceId);
    const second = await sync(guest.cookie, id, { full: true });
    expect(second.json.counts.created).toBe(0);
    expect(second.json.counts.findings_opened).toBe(0);
    expect(await quantities(guest.workspaceId)).toEqual(before);
    const f = (await findings(guest.cookie)).find((x) => x.kind === "unit_mismatch");
    const prop = await call(`/api/v1/reconciliation/${f.id}/advance`, {
      method: "POST",
      cookie: guest.cookie,
      body: { to: "Investigating", version: f.version },
    });
    const prop2 = await call(`/api/v1/reconciliation/${f.id}/advance`, {
      method: "POST",
      cookie: guest.cookie,
      body: { to: "Proposed", version: prop.json.version, proposal: "Ask ops" },
    });
    const done = await call(`/api/v1/reconciliation/${f.id}/resolve`, {
      method: "POST",
      cookie: guest.cookie,
      headers: { "idempotency-key": `inv-${Date.now()}-x` },
      body: { decision: "approve", version: prop2.json.version },
    });
    expect(done.json.status).toBe("Resolved");
    expect(await quantities(guest.workspaceId)).toEqual(before);
  });

  it("duplicate records and an older version change nothing current", async () => {
    const { guest, id } = await fresh();
    const dup = await sync(guest.cookie, id, { scenario: "duplicate_event" });
    expect(dup.json.counts.unchanged).toBeGreaterThan(0);
    const stale = await sync(guest.cookie, id, { scenario: "stale_version" });
    expect(stale.json.counts.stale_skipped).toBe(1);
    const view = await call("/api/v1/inventory", { cookie: guest.cookie });
    const sku = view.json.items.find((i: any) => i.code === "SKU-102");
    const latest = sku.snapshots.find((s: any) => s.externalId === "INV-203");
    expect(latest.sourceVersion).toBe(3);
    expect(latest.quantity).toBe("7");
    expect(latest.versions).toBe(2);
  });

  it("is GET only, and the role can't change an item or a recorded quantity", async () => {
    const { guest } = await fresh();
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const res = await call("/api/v1/inventory", { method, cookie: guest.cookie });
      expect(res.status).toBe(404);
    }
    const app = await connect("opsbridge_app");
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.workspace_id', $1, true)", [guest.workspaceId]);
    await expect(app.query("UPDATE app.inventory_snapshots SET quantity = 1")).rejects.toThrow(
      /permission denied/,
    );
    await app.query("ROLLBACK");
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.workspace_id', $1, true)", [guest.workspaceId]);
    await expect(app.query("UPDATE app.inventory_items SET description = 'x'")).rejects.toThrow(
      /permission denied/,
    );
    await app.query("ROLLBACK");
    await app.end();
  });

  it("is scoped: two workspaces don't see each other's snapshots", async () => {
    const a = await fresh();
    const b = await fresh();
    await sync(a.guest.cookie, a.id);
    const view = await call("/api/v1/inventory", { cookie: b.guest.cookie });
    expect(view.json.unresolved).toEqual([]);
    expect((await counts(b.guest.workspaceId, ["inventory_snapshots"])).inventory_snapshots).toBe(
      2,
    );
    expect(
      (await call(`/api/v1/integrations/${a.id}/runs`, { cookie: b.guest.cookie })).status,
    ).toBe(404);
  });

  it("the shared view is read-only template data, and pages and bad input behave", async () => {
    const { guest } = await fresh();
    const shared = await call("/api/v1/inventory?scope=shared&limit=2", { cookie: guest.cookie });
    expect(shared.json.items).toHaveLength(2);
    const next = await call(
      `/api/v1/inventory?scope=shared&limit=2&cursor=${shared.json.nextCursor}`,
      {
        cookie: guest.cookie,
      },
    );
    expect(next.json.items[0].code).not.toBe(shared.json.items[0].code);
    expect((await call("/api/v1/inventory?limit=0", { cookie: guest.cookie })).status).toBe(400);
    expect((await call("/api/v1/inventory?cursor=%27", { cookie: guest.cookie })).status).toBe(400);
  });

  it("a handoff can reference an item, and the case shows it", async () => {
    const { guest } = await fresh();
    const pack = await packCases(guest);
    const view = await call("/api/v1/inventory", { cookie: guest.cookie });
    const item = view.json.items[0];
    const kase = pack["case-1"] as { id: string; version: number };
    const res = await call(`/api/v1/cases/${kase.id}/handoffs`, {
      method: "POST",
      cookie: guest.cookie,
      body: {
        toQueue: "Seasonal Staffing",
        reason: "Needs the stock count for this site",
        expectedCaseVersion: kase.version,
        inventoryItemId: item.id,
      },
    });
    expect(res.status).toBe(201);
    const detail = await call(`/api/v1/cases/${kase.id}`, { cookie: guest.cookie });
    expect(detail.json.handoffs[0].itemCode).toBe(item.code);
  });

  it("a handoff can't reference another workspace's item", async () => {
    const a = await fresh();
    const b = await fresh();
    const pack = await packCases(a.guest);
    const stranger = (await call("/api/v1/inventory", { cookie: b.guest.cookie })).json.items[0].id;
    const kase = pack["case-1"] as { id: string; version: number };
    const res = await call(`/api/v1/cases/${kase.id}/handoffs`, {
      method: "POST",
      cookie: a.guest.cookie,
      body: {
        toQueue: "Seasonal Staffing",
        reason: "x",
        expectedCaseVersion: kase.version,
        inventoryItemId: stranger,
      },
    });
    expect(res.status).toBe(404);
    expect((await call(`/api/v1/cases/${kase.id}`, { cookie: a.guest.cookie })).json.version).toBe(
      kase.version,
    );
  });
});
