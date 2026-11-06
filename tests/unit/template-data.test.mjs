import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTemplate } from "../../scripts/lib/template-data.mjs";

const manifest = JSON.parse(readFileSync("sample-data/seed-manifest.json", "utf8"));

describe("template data", () => {
  const { customers, cases } = buildTemplate(manifest);

  it("is deterministic", () => {
    expect(buildTemplate(manifest)).toEqual({ customers, cases });
  });
  it("meets the manifest counts", () => {
    expect(customers).toHaveLength(manifest.template.organizations);
    expect(cases).toHaveLength(manifest.template.cases.total);
    for (const [status, n] of Object.entries(manifest.template.cases.byStatus)) {
      expect(cases.filter((c) => c.status === status)).toHaveLength(n);
    }
  });
  it("marks a pack of 2 customers and 3 cases whose customers are in the pack", () => {
    const packCustomers = customers.filter((c) => c.pack_key);
    const packCases = cases.filter((c) => c.pack_key);
    expect(packCustomers).toHaveLength(manifest.scenarioPack.rows.customers);
    expect(packCases).toHaveLength(manifest.scenarioPack.rows.cases);
    const ids = new Set(packCustomers.map((c) => c.id));
    expect(packCases.every((c) => ids.has(c.customer_id))).toBe(true);
  });
  it("names every organization as fictional and uses no real-looking identifiers", () => {
    expect(customers.every((c) => c.canonical_name.endsWith("(fictional)"))).toBe(true);
    const text = JSON.stringify({ customers, cases });
    expect(text).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(text).not.toMatch(/@/);
  });
});
