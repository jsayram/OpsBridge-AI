import { describe, expect, it } from "vitest";
import {
  crmAdapter,
  erpAdapter,
  inventoryAdapter,
  simulatedAdapter,
} from "../../backend/src/integrations/adapters";
import { DEFAULT_POLICY } from "../../backend/src/integrations/http";
import { SCENARIO_NAMES, SCENARIOS } from "../../backend/src/integrations/scenarios";
import {
  crmSimulator,
  erpSimulator,
  inventorySimulator,
  SIMULATOR_ORIGIN,
} from "../../backend/src/integrations/simulators";

const options = { scenario: "baseline" as const, faultsActive: true, shiftMs: 0 };
const sim = erpSimulator(options);
const get = async (path: string) => {
  const res = await sim(new Request(`${SIMULATOR_ORIGIN}${path}`));
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    body: (await res.json()) as any,
  };
};
const suiteql = async (
  q: string,
  query = "limit=2&offset=0",
  headers: Record<string, string> = { prefer: "transient" },
  params?: unknown[],
) => {
  const res = await sim(
    new Request(`${SIMULATOR_ORIGIN}/services/rest/query/v1/suiteql?${query}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ q, ...(params ? { params } : {}) }),
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
};
const Q = "SELECT id, companyname, lastmodifieddate FROM customer ORDER BY lastmodifieddate, id";

describe("ERP Simulator: documented SuiteTalk REST conventions", () => {
  it("a record collection has links, count, offset, hasMore, totalResults and ID stubs", async () => {
    const { body } = await get("/services/rest/record/v1/customer?limit=2&offset=0");
    expect(Object.keys(body).sort()).toEqual([
      "count",
      "hasMore",
      "items",
      "links",
      "offset",
      "totalResults",
    ]);
    expect(body.count).toBe(2);
    expect(body.hasMore).toBe(true);
    expect(body.totalResults).toBe(5);
    expect(Object.keys(body.items[0]).sort()).toEqual(["id", "links"]);
    expect(body.items[0].links[0].rel).toBe("self");
    expect(body.links.map((l: any) => l.rel).sort()).toEqual(["next", "self"]);
  });

  it("the last page has prev, no next, and hasMore false", async () => {
    const { body } = await get("/services/rest/record/v1/customer?limit=2&offset=4");
    expect(body.hasMore).toBe(false);
    expect(body.count).toBe(1);
    expect(body.links.map((l: any) => l.rel).sort()).toEqual(["prev", "self"]);
  });

  it("offset must be divisible by limit", async () => {
    const res = await get("/services/rest/record/v1/customer?limit=2&offset=3");
    expect(res.status).toBe(400);
    expect(res.body["o:errorDetails"][0]["o:errorCode"]).toBe("INVALID_PARAMETER");
  });

  it("a single record returns the fields, by internal ID", async () => {
    const { body } = await get("/services/rest/record/v1/customer/5001");
    expect(body.entityid).toBe("ERP-BT-5001");
    expect(body.stage).toBe("CUSTOMER");
  });

  it("an unknown record is 404 NONEXISTENT_ID in the o:errorDetails shape", async () => {
    const res = await get("/services/rest/record/v1/customer/999");
    expect(res.status).toBe(404);
    expect(res.type).toContain("type=error");
    expect(res.body).toMatchObject({ title: "Not Found", status: 404 });
    expect(res.body["o:errorDetails"][0]).toMatchObject({ "o:errorCode": "NONEXISTENT_ID" });
  });

  it("SuiteQL needs Prefer: transient and a q body", async () => {
    expect((await suiteql(Q, "limit=2&offset=0", {})).status).toBe(400);
    const ok = await suiteql(Q);
    expect(ok.status).toBe(200);
    expect(ok.body.count).toBe(2);
    expect(ok.body.items[0].companyname).toContain("(fictional)");
  });

  it("SuiteQL refuses a query outside the allowed shapes", async () => {
    expect((await suiteql("DROP TABLE customer")).status).toBe(400);
    expect((await suiteql("SELECT * FROM employee ORDER BY lastmodifieddate, id")).status).toBe(
      400,
    );
  });

  it("bound parameters filter a delta", async () => {
    const res = await suiteql(
      "SELECT id FROM customer WHERE lastmodifieddate >= ? ORDER BY lastmodifieddate, id",
      "limit=10&offset=0",
      { prefer: "transient" },
      ["2026-01-14T08:10:00Z"],
    );
    expect(res.body.totalResults).toBe(3);
  });

  it("uses the field that lets one record type hold leads, prospects and customers", async () => {
    const { body } = await get("/services/rest/record/v1/customer/5002");
    expect(body.parent).toBe("5001");
    expect(body.custentity_ob_crm_account_id).toBe("CRM-ORG-1001");
  });
});

describe("adapters over the simulators", () => {
  const read = async (adapter: any) => {
    const items: any[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await adapter.list({ limit: adapter.pageSize, ...(cursor ? { cursor } : {}) });
      items.push(...page.items);
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    return { items, pages };
  };

  it("the ERP adapter walks both streams in order", async () => {
    const { items, pages } = await read(erpAdapter(erpSimulator(options)));
    expect(pages).toBe(5);
    expect(items.filter((i) => i.stream === "customer")).toHaveLength(5);
    expect(items.filter((i) => i.stream === "invoice")).toHaveLength(12);
  });

  it("the CRM adapter follows nextRecordsUrl", async () => {
    const adapter = crmAdapter(crmSimulator(options), {
      provider: "crm_simulator",
      mode: "simulated",
      base: SIMULATOR_ORIGIN,
      pageSize: 2,
    });
    const { items, pages } = await read(adapter);
    expect(items).toHaveLength(3);
    expect(pages).toBe(2);
  });

  it("the inventory adapter pages", async () => {
    const { items, pages } = await read(inventoryAdapter(inventorySimulator(options)));
    expect(items).toHaveLength(7);
    expect(pages).toBe(3);
  });

  it("a cursor from elsewhere is refused, and a CRM cursor can't point at another host", async () => {
    const erp = erpAdapter(erpSimulator(options));
    await expect(erp.list({ cursor: "../../etc", limit: 4 })).rejects.toMatchObject({
      failure: "cursor",
    });
    const crm = crmAdapter(crmSimulator(options), {
      provider: "crm_simulator",
      mode: "simulated",
      base: SIMULATOR_ORIGIN,
      pageSize: 2,
    });
    await expect(
      crm.list({ cursor: "https://evil.example.com/x", limit: 2 }),
    ).rejects.toMatchObject({ failure: "cursor" });
    await expect(
      crm.list({ cursor: "//evil.example.com/services/data/v62.0/query/x", limit: 2 }),
    ).rejects.toMatchObject({ failure: "cursor" });
  });

  it("every provider reports Simulated mode, and every fault name is covered", () => {
    for (const provider of ["crm_simulator", "erp_simulator", "inventory_simulator"] as const) {
      expect(simulatedAdapter(provider, { ...options, policy: DEFAULT_POLICY }).mode).toBe(
        "simulated",
      );
    }
    const prd84 = [
      "http_401",
      "http_403",
      "http_429",
      "http_5xx_transient",
      "timeout",
      "duplicate_event",
      "out_of_order",
      "renamed_customer",
      "stale_version",
      "deleted_record",
      "mismatched_account",
    ];
    for (const fault of prd84) expect(SCENARIO_NAMES).toContain(fault);
    for (const fault of ["malformed_payload", "unknown_field"])
      expect(SCENARIO_NAMES).toContain(fault);
    expect(Object.values(SCENARIOS).every((s) => s.label.length > 0)).toBe(true);
  });
});
