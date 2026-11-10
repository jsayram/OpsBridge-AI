import { describe, expect, it } from "vitest";
import {
  canAdvance,
  decisionTarget,
  FINDING_STATUSES,
} from "../../backend/src/domain/findingStatus";
import {
  type DetectInput,
  detectFindings,
  findingKey,
  fingerprint,
  normalizeName,
  type SourceFact,
} from "../../backend/src/domain/reconcile";
import {
  mapCrmOrganization,
  mapErpCustomer,
  mapErpInvoice,
  mapInventoryFact,
} from "../../backend/src/integrations/mappers";

const at = "2026-01-14T08:00:00.000Z";
const erp = (externalId: string, data: Record<string, unknown>): SourceFact => ({
  provider: "erp_simulator",
  externalType: "customer",
  externalId,
  sourceModifiedAt: at,
  externalVersion: at,
  state: "active",
  data: { stage: "CUSTOMER", entityId: `E-${externalId}`, ...data },
});
const crm = (externalId: string, name: string): SourceFact => ({
  provider: "crm_simulator",
  externalType: "organization",
  externalId,
  sourceModifiedAt: at,
  externalVersion: at,
  state: "active",
  data: { name, crmType: "Customer", accountNumber: null },
});
const input = (over: Partial<DetectInput>): DetectInput => ({
  now: at,
  sources: [],
  customers: [],
  links: [],
  items: [],
  snapshots: [],
  ...over,
});
const customer = {
  id: "c1",
  canonicalName: "Acme Foods LLC",
  accountCode: "A1",
  lifecycleStatus: "Active",
};

describe("normalization and keys", () => {
  it("removes only case, punctuation, legal suffix and the fixture marker", () => {
    expect(normalizeName("Cedar Point Landscaping, Inc. (fictional)")).toBe(
      "cedar point landscaping",
    );
    expect(normalizeName("CEDAR POINT LANDSCAPING INC")).toBe("cedar point landscaping");
    expect(normalizeName("Harbor Ridge L.L.C.")).toBe("harbor ridge");
  });
  it("keeps names that are merely similar apart", () => {
    expect(normalizeName("Harbor Ridge Packing LLC")).not.toBe(
      normalizeName("Harbor Ridge Produce LLC"),
    );
    expect(normalizeName("Cedar Point")).not.toBe(normalizeName("Cedar Pointe"));
  });
  it("keys ignore field order and change with the facts", () => {
    expect(findingKey("name_mismatch", "s", { a: "1", b: "2" })).toBe(
      findingKey("name_mismatch", "s", { b: "2", a: "1" }),
    );
    expect(findingKey("name_mismatch", "s", { a: "1" })).not.toBe(
      findingKey("name_mismatch", "s", { a: "2" }),
    );
    expect(fingerprint("abc")).toHaveLength(16);
  });
});

describe("matching order", () => {
  it("an exact cross-reference links one bill-to even when the name is nothing alike", () => {
    const { exactLinks, findings } = detectFindings(
      input({
        sources: [
          crm("CRM1", "Acme Foods LLC"),
          erp("9", { name: "Totally Different Name", crmAccountId: "CRM1" }),
        ],
        customers: [customer],
        links: [
          {
            provider: "crm_simulator",
            externalType: "organization",
            externalId: "CRM1",
            canonicalId: "c1",
          },
        ],
      }),
    );
    expect(exactLinks).toEqual([
      { provider: "erp_simulator", externalType: "customer", externalId: "9", customerId: "c1" },
    ]);
    expect(findings).toEqual([]);
  });

  it("two bill-tos for one CRM organization are a definition conflict and link nothing", () => {
    const { exactLinks, findings } = detectFindings(
      input({
        sources: [
          crm("CRM1", "Acme Foods LLC"),
          erp("9", { name: "Acme Holdings", crmAccountId: "CRM1" }),
          erp("10", { name: "Acme Packing", crmAccountId: "CRM1" }),
        ],
        customers: [customer],
        links: [
          {
            provider: "crm_simulator",
            externalType: "organization",
            externalId: "CRM1",
            canonicalId: "c1",
          },
        ],
      }),
    );
    expect(exactLinks).toEqual([]);
    expect(findings.map((f) => f.kind)).toEqual(["definition_conflict"]);
    expect(findings[0]?.evidence.resolution).toMatchObject({
      type: "link_bill_tos",
      externalIds: ["10", "9"],
    });
  });

  it("P3-F: a near-identical name with no ID links nothing and proposes nothing", () => {
    const { exactLinks, findings } = detectFindings(
      input({
        sources: [erp("9", { name: "Acme Foods Packing LLC" })],
        customers: [customer],
      }),
    );
    expect(exactLinks).toEqual([]);
    expect(findings.map((f) => f.kind)).toEqual(["missing_client"]);
  });

  it("P3-F: an equal normalized name only suggests, and the suggestion needs a person", () => {
    const { exactLinks, findings } = detectFindings(
      input({ sources: [erp("9", { name: "ACME FOODS, L.L.C." })], customers: [customer] }),
    );
    expect(exactLinks).toEqual([]);
    expect(findings[0]?.kind).toBe("duplicate_client");
    expect(findings[0]?.evidence.matchBasis).toBe("normalized_name");
    expect(findings[0]?.evidence.resolution).toMatchObject({
      type: "link_or_create",
      suggestedCustomerId: "c1",
    });
  });

  it("is deterministic: same input, same keys", () => {
    const i = input({ sources: [erp("9", { name: "ACME FOODS, L.L.C." })], customers: [customer] });
    expect(detectFindings(i).findings.map((f) => f.dedupeKey)).toEqual(
      detectFindings(i).findings.map((f) => f.dedupeKey),
    );
  });

  it("a name that matches changes nothing", () => {
    const { findings } = detectFindings(
      input({
        sources: [erp("9", { name: "Acme Foods LLC", accountNumber: "A1" })],
        customers: [customer],
        links: [
          {
            provider: "erp_simulator",
            externalType: "customer",
            externalId: "9",
            canonicalId: "c1",
          },
        ],
      }),
    );
    expect(findings).toEqual([]);
  });
});

describe("inventory rules", () => {
  const items = [{ id: "i1", code: "SKU-1", canonicalUnit: "box" }];
  const snap = (over: Record<string, unknown>) => ({
    externalId: "S1",
    itemCode: "SKU-1",
    itemId: "i1",
    quantity: "1",
    unit: "box",
    sourceVersion: 1,
    observedAt: at,
    location: null,
    ...over,
  });
  it("a clean snapshot opens nothing", () => {
    expect(detectFindings(input({ items, snapshots: [snap({})] })).findings).toEqual([]);
  });
  it("only the newest version of a source record counts", () => {
    const { findings } = detectFindings(
      input({ items, snapshots: [snap({ unit: "each" }), snap({ sourceVersion: 2 })] }),
    );
    expect(findings).toEqual([]);
  });
  it("names each problem, and never in a way that changes a quantity", () => {
    const kinds = (s: Record<string, unknown>) =>
      detectFindings(input({ items, snapshots: [snap(s)] })).findings.map((f) => f.kind);
    expect(kinds({ itemId: null, itemCode: "NOPE" })).toEqual(["unknown_sku"]);
    expect(kinds({ unit: "each" })).toEqual(["unit_mismatch"]);
    expect(kinds({ unit: "pallet" })).toEqual(["invalid_unit"]);
    expect(kinds({ observedAt: "2025-12-01T00:00:00.000Z" })).toEqual(["stale_snapshot"]);
    const all = detectFindings(input({ items, snapshots: [snap({ unit: "each" })] })).findings;
    expect(all.every((f) => f.evidence.resolution.type === "acknowledge")).toBe(true);
  });
});

describe("mappers", () => {
  const goodErp = {
    id: "1",
    entityid: "E1",
    companyname: "Name",
    stage: "CUSTOMER",
    lastmodifieddate: at,
  };
  it("drops and counts unknown fields, and keeps only the allowlist", () => {
    const out = mapErpCustomer({ ...goodErp, extra_field: "x", another: 1 });
    expect(out.ok && out.value.unknownFields).toBe(2);
    expect(JSON.stringify(out)).not.toContain("extra_field");
  });
  it("rejects privileged fields in any spelling", () => {
    for (const key of [
      "workspace_id",
      "workspaceId",
      "canonical_id",
      "role",
      "isAdmin",
      "password",
      "access_token",
      "api_key",
      "SSN",
    ]) {
      const out = mapErpCustomer({ ...goodErp, [key]: "x" });
      expect(out, key).toEqual({
        ok: false,
        rejected: { externalId: "1", reason: "privileged_field" },
      });
    }
  });
  it("refuses bad shapes without throwing", () => {
    for (const raw of [null, 7, "x", [], {}]) {
      expect(mapErpCustomer(raw).ok).toBe(false);
      expect(mapCrmOrganization(raw).ok).toBe(false);
      expect(mapErpInvoice(raw).ok).toBe(false);
      expect(mapInventoryFact(raw).ok).toBe(false);
    }
    expect(mapErpCustomer({ ...goodErp, id: "a b/../c" }).ok).toBe(false);
    expect(mapErpCustomer({ ...goodErp, stage: "ADMIN" }).ok).toBe(false);
    expect(mapErpCustomer({ ...goodErp, lastmodifieddate: "not a date" }).ok).toBe(false);
  });
  it("validates quantities and money", () => {
    const fact = {
      externalId: "S",
      itemCode: "I",
      quantity: "1",
      unit: "each",
      location: null,
      version: 1,
      sourceTimestamp: at,
    };
    expect(mapInventoryFact(fact).ok).toBe(true);
    expect(mapInventoryFact({ ...fact, quantity: "-1" }).ok).toBe(false);
    expect(mapInventoryFact({ ...fact, quantity: "1e9" }).ok).toBe(false);
    expect(mapInventoryFact({ ...fact, version: 0 }).ok).toBe(false);
    const inv = {
      id: "1",
      tranid: "T",
      entity: "9",
      foreigntotal: "10.50",
      currency: "USD",
      trandate: "2026-01-01",
      status: "A",
      lastmodifieddate: at,
    };
    expect(mapErpInvoice(inv).ok).toBe(true);
    expect(mapErpInvoice({ ...inv, foreigntotal: "ten" }).ok).toBe(false);
    expect(mapErpInvoice({ ...inv, currency: "usd" }).ok).toBe(false);
    expect(mapErpInvoice({ ...inv, status: "Z" }).ok).toBe(false);
  });
});

describe("finding state machine", () => {
  it("allows only the documented moves", () => {
    const allowed: string[] = [];
    for (const from of FINDING_STATUSES) {
      for (const to of FINDING_STATUSES) if (canAdvance(from, to)) allowed.push(`${from}>${to}`);
    }
    expect(allowed.sort()).toEqual([
      "Deferred>Open",
      "Investigating>Proposed",
      "Open>Investigating",
    ]);
  });
  it("approves only from Proposed, and never reopens a closed finding", () => {
    expect(decisionTarget("Proposed", "approve")).toBe("Resolved");
    expect(decisionTarget("Open", "approve")).toBeNull();
    expect(decisionTarget("Investigating", "reject")).toBe("Dismissed");
    expect(decisionTarget("Proposed", "defer")).toBe("Deferred");
    for (const closed of ["Resolved", "Dismissed", "Deferred"] as const) {
      expect(decisionTarget(closed, "approve")).toBeNull();
      expect(decisionTarget(closed, "reject")).toBeNull();
    }
  });
});
