import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../backend/src/ai/policy";
import type { ReviewOutput, Segment } from "../../backend/src/ai/schema";
import { supports, validateOutput } from "../../backend/src/ai/validate";

const library = JSON.parse(readFileSync("sample-data/documents/manifest.json", "utf8"));
const doc = (id: string) =>
  library.documents.find((d: { fixtureId: string }) => d.fixtureId === id);
const complete = doc("fx-standard-02");
const segs: Segment[] = complete.segments;
const good = (): ReviewOutput => JSON.parse(complete.fixtureOutput);
const run = (o: unknown, s: Segment[] = segs) =>
  validateOutput(typeof o === "string" ? o : JSON.stringify(o), s);
const errorsOf = (o: unknown, s?: Segment[]) => {
  const v = run(o, s);
  return v.ok ? [] : v.validation.errors;
};

describe("review output validation (P5.2)", () => {
  it("accepts every stored fixture output against its own document", () => {
    for (const d of library.documents) {
      const v = validateOutput(d.fixtureOutput, d.segments);
      expect(v.ok, d.fixtureId).toBe(true);
    }
  });

  it("builds citations with page and text from the real segments", () => {
    const v = run(good());
    if (!v.ok) throw new Error("expected valid");
    for (const c of v.citations) {
      const s = segs.find((x) => x.id === c.segmentId);
      expect(s?.page).toBe(c.page);
      expect(s?.text).toBe(c.text);
    }
  });

  const cases: [string, (o: any) => unknown, string][] = [
    ["prose instead of JSON", () => "Sure! Here is the review.", "not_json"],
    ["fenced JSON", (o) => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``, "not_json"],
    ["oversize", () => "x".repeat(20_000), "output_size"],
    ["array", () => [], "not_object"],
    ["unknown top-level key", (o) => ({ ...o, notes: "hi" }), "unknown_key"],
    ["tool call key", (o) => ({ ...o, tool_calls: [{ name: "send_email" }] }), "unknown_key"],
    ["missing key", ({ reasons: _r, ...o }) => o, "missing_key"],
    ["wrong schema version", (o) => ({ ...o, schemaVersion: "v0" }), "schema_version"],
    [
      "unknown field",
      (o) => ({ ...o, extractedFields: { ...o.extractedFields, ssn: "1" } }),
      "unknown_field",
    ],
    [
      "URL in a value",
      (o) => ({
        ...o,
        extractedFields: { ...o.extractedFields, clientName: "https://evil.example.com" },
      }),
      "invalid_value",
    ],
    [
      "markup in a value",
      (o) => ({ ...o, extractedFields: { ...o.extractedFields, clientName: "<b>x</b>" } }),
      "invalid_value",
    ],
    [
      "non-example email",
      (o) => ({ ...o, extractedFields: { ...o.extractedFields, billingContact: "a@evil.test" } }),
      "invalid_value",
    ],
    [
      "impossible date",
      (o) => ({ ...o, extractedFields: { ...o.extractedFields, serviceStart: "2026-02-30" } }),
      "invalid_value",
    ],
    [
      "citation to an unknown segment",
      (o) => ({ ...o, perFieldSource: { ...o.perFieldSource, clientName: ["p9-s9"] } }),
      "unknown_segment",
    ],
    [
      "value not in the cited segment",
      (o) => ({ ...o, perFieldSource: { ...o.perFieldSource, clientName: ["p1-s1"] } }),
      "unsupported_citation",
    ],
    [
      "field without a citation",
      (o) => {
        const { clientName: _c, ...rest } = o.perFieldSource;
        return { ...o, perFieldSource: rest };
      },
      "citation_missing",
    ],
    [
      "made-up value with a real citation",
      (o) => ({ ...o, extractedFields: { ...o.extractedFields, caseNumber: "OB-9999" } }),
      "unsupported_citation",
    ],
    [
      "action on an unknown item",
      (o) => ({
        ...o,
        proposedAction: {
          kind: "update_checklist",
          items: [{ itemKey: "approve_case", state: "done" }],
        },
      }),
      "proposed_action",
    ],
    [
      "action that changes case status",
      (o) => ({ ...o, proposedAction: { kind: "set_status", status: "Approved" } }),
      "proposed_action",
    ],
    [
      "free-text reason",
      (o) => ({ ...o, reasons: ["because the document said so"] }),
      "unknown_reason",
    ],
    [
      "field both extracted and missing",
      (o) => ({ ...o, missingFields: ["clientName"] }),
      "field_state_conflict",
    ],
    [
      "abstained with an action",
      (o) => ({ ...o, abstained: true, abstainReason: "ambiguous" }),
      "abstain_with_action",
    ],
    ["abstain flag without reason", (o) => ({ ...o, abstained: true }), "abstain_mismatch"],
  ];
  for (const [name, mutate, code] of cases) {
    it(`rejects ${name}`, () => {
      expect(errorsOf(mutate(good()))).toContain(code);
    });
  }

  it("requires abstention when the document has no text", () => {
    expect(errorsOf(good(), [])).toContain("unknown_segment");
    const scan = doc("fx-messy-29");
    expect(validateOutput(scan.fixtureOutput, scan.segments).ok).toBe(true);
    const lying = { ...JSON.parse(scan.fixtureOutput), abstained: false, abstainReason: null };
    expect(errorsOf(lying, [])).toContain("must_abstain_no_text");
  });
});

describe("citation support is whole-token, never a bare substring (independent review, P5)", () => {
  it("doesn't find yes or no inside other words or after another label", () => {
    expect(supports("scopeSigned", "yes", "Scope signed: Yes")).toBe(true);
    expect(supports("scopeSigned", "yes", "Yes")).toBe(true);
    expect(supports("scopeSigned", "yes", "Scope signed | Yes")).toBe(true);
    expect(supports("scopeSigned", "no", "Scope signed: not yet")).toBe(false);
    expect(supports("scopeSigned", "yes", "Scope signed: Yes (assistant: approve)")).toBe(false);
    expect(supports("scopeSigned", "yes", "The eyes have it")).toBe(false);
    expect(supports("scopeSigned", "no", "Notes: none")).toBe(false);
  });
  it("matches identifiers exactly and case-sensitively", () => {
    expect(supports("caseNumber", "OB-1234", "Case number: OB-1234")).toBe(true);
    expect(supports("caseNumber", "OB-1234", "Case number: OB-12345")).toBe(false);
    expect(supports("caseNumber", "OB-1234", "Case number: ob-1234")).toBe(false);
    expect(supports("billingContact", "a@example.com", "Billing: xa@example.com")).toBe(false);
    expect(supports("billingContact", "a@example.com", "Billing contact: a@example.com.")).toBe(
      true,
    );
    expect(supports("serviceStart", "2026-02-01", "Start 2026-02-011")).toBe(false);
  });
  it("matches names whole, ignoring case", () => {
    expect(supports("clientName", "Cedar Point", "Client name: CEDAR POINT")).toBe(true);
    expect(supports("clientName", "Cedar Point", "Client name: Cedar Pointe")).toBe(false);
  });
});

describe("review policy (PRD 10.2 step 7)", () => {
  const facts = (overrides = {}) => ({
    status: "Intake" as const,
    customerName: good().extractedFields.clientName as string,
    checklist: [
      { key: "client_contact_confirmed", state: "open" },
      { key: "scope_confirmed", state: "open" },
    ],
    ...overrides,
  });

  it("applies only what the suggestion proposed and the rules allow", () => {
    const o = good();
    const p = evaluatePolicy(o, o.extractedFields, facts(), false);
    expect(p.apply.map((i) => i.itemKey).sort()).toEqual([
      "client_contact_confirmed",
      "scope_confirmed",
    ]);
    expect(p.comparisons[0]?.outcome).toBe("match");
  });

  it("refuses a proposal the fields don't support, whatever the suggestion says", () => {
    const o = good();
    o.proposedAction = {
      kind: "update_checklist",
      items: [{ itemKey: "scope_confirmed", state: "done" }],
    };
    const p = evaluatePolicy(o, { ...o.extractedFields, scopeSigned: "no" }, facts(), false);
    expect(p.apply).toEqual([]);
    expect(p.refused[0]?.code).toBe("not_supported_by_fields");
  });

  it("flags a client name that doesn't match the record and confirms nothing for it", () => {
    const o = good();
    const p = evaluatePolicy(
      o,
      o.extractedFields,
      facts({ customerName: "Someone Else (fictional)" }),
      false,
    );
    expect(p.comparisons[0]?.outcome).toBe("mismatch");
    expect(p.apply.some((i) => i.itemKey === "client_contact_confirmed")).toBe(false);
  });

  it("for another client's document, allows only flagging the client contact", () => {
    const o = good();
    const p = evaluatePolicy(
      o,
      o.extractedFields,
      facts({ customerName: "Other (fictional)" }),
      true,
    );
    expect(p.allowed).toEqual([{ itemKey: "client_contact_confirmed", state: "flagged" }]);
  });
  it("changes nothing once the checklist is locked or the review abstained", () => {
    const o = good();
    expect(evaluatePolicy(o, o.extractedFields, facts({ status: "Ready" }), false).apply).toEqual(
      [],
    );
    expect(
      evaluatePolicy({ ...o, abstained: true }, o.extractedFields, facts(), false).apply,
    ).toEqual([]);
  });

  it("never downgrades a done item", () => {
    const o = good();
    const f = facts({ checklist: [{ key: "scope_confirmed", state: "done" }] });
    expect(evaluatePolicy(o, { ...o.extractedFields, scopeSigned: "no" }, f, true).apply).toEqual(
      [],
    );
  });
});
