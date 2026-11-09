import { describe, expect, it } from "vitest";
import {
  CONDITION_FIELDS,
  describeCondition,
  EVENT_TYPES,
  matches,
  matchingRules,
  parseCondition,
  parseRuleName,
  type Rule,
  RuleError,
} from "../../backend/src/domain/rules";
import { sheetCell, simulatedSink, summaryOf } from "../../backend/src/integrations/sinks";

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: "r1",
  name: "Notify",
  trigger: "approval.completed",
  condition: { queue: "Field Services" },
  action: "simulated_notice",
  enabled: true,
  version: 1,
  ...over,
});

describe("typed rule conditions", () => {
  it("covers exactly the five allowlisted triggers", () => {
    expect([...EVENT_TYPES].sort()).toEqual(Object.keys(CONDITION_FIELDS).sort());
    expect(EVENT_TYPES).toHaveLength(5);
  });

  it("accepts listed fields with listed values, and returns a fresh object", () => {
    const input = { queue: "Seasonal Staffing", decision: "approved" };
    const out = parseCondition("approval.completed", input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(parseCondition("integration.degraded", {})).toEqual({});
  });

  it.each([
    ["URL value", { queue: "https://example.com" }],
    ["unknown field", { url: "x" }],
    ["recipient field", { recipient: "a@b.c" }],
    ["field from another trigger", { kind: "name_mismatch" }],
    ["non-string value", { queue: 1 }],
    ["object value", { queue: { $ne: 1 } }],
    ["array", ["queue"]],
    ["string", "queue = x"],
    ["null", null],
    ["too many keys", { queue: "Field Services", decision: "approved", x: "y" }],
  ])("rejects a %s", (_, input) => {
    expect(() => parseCondition("approval.completed", input)).toThrow(RuleError);
  });

  it("ignores inherited properties: __proto__ and constructor are not fields", () => {
    const parsed = JSON.parse('{"__proto__":{"queue":"Field Services"}}');
    expect(() => parseCondition("approval.completed", parsed)).toThrow(RuleError);
    expect(() => parseCondition("approval.completed", { constructor: "x" })).toThrow(RuleError);
    expect(() => parseCondition("approval.completed", { toString: "x" })).toThrow(RuleError);
  });

  it("names can't carry an address, a link or a template", () => {
    expect(parseRuleName("  Notify finance  ")).toBe("Notify finance");
    for (const bad of [
      "a@b.c",
      "see https://x",
      "www.example.com",
      ["$", "{x}"].join(""),
      "{{x}}",
      "<b>",
      "",
      "x".repeat(121),
    ]) {
      expect(() => parseRuleName(bad), bad).toThrow(RuleError);
    }
  });
});

describe("one evaluator for every team (JOB-TEST-06)", () => {
  const field = rule();
  const seasonal = rule({ id: "r2", condition: { queue: "Seasonal Staffing" } });

  it("routes each team's event to its own rule only", () => {
    const data = (queue: string) => ({ caseRef: "CASE-1", decision: "approved", queue });
    expect(matchingRules([field, seasonal], "approval.completed", data("Field Services"))).toEqual([
      field,
    ]);
    expect(
      matchingRules([field, seasonal], "approval.completed", data("Seasonal Staffing")),
    ).toEqual([seasonal]);
  });

  it("an empty condition matches every event of its trigger; disabled or other triggers never match", () => {
    expect(matches(rule({ condition: {} }), "approval.completed", {})).toBe(true);
    expect(
      matches(rule({ enabled: false }), "approval.completed", { queue: "Field Services" }),
    ).toBe(false);
    expect(matches(rule(), "case.created", { queue: "Field Services" })).toBe(false);
  });

  it("describes a condition in plain words", () => {
    expect(describeCondition({ queue: "Field Services", decision: "approved" })).toBe(
      "team is Field Services and decision is approved",
    );
    expect(describeCondition({})).toBe("every event of this type");
  });
});

describe("sink helpers", () => {
  it("a spreadsheet cell can't start a formula", () => {
    for (const v of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx"])
      expect(sheetCell(v).startsWith("'")).toBe(true);
    expect(sheetCell("CASE-1")).toBe("CASE-1");
    expect(sheetCell("x".repeat(300))).toHaveLength(200);
  });

  it("the summary carries data fields only, no references", () => {
    expect(
      summaryOf({
        id: "e",
        type: "approval.completed",
        occurredAt: "t",
        data: { caseRef: "CASE-1", decision: "approved", queue: "Field Services" },
      }),
    ).toBe("decision=approved; queue=Field Services");
  });

  it("the simulated sink never claims more than a simulation", async () => {
    expect(
      await simulatedSink(0).deliver({ id: "e", type: "x", occurredAt: "t", data: {} }),
    ).toEqual({ kind: "simulated", evidenceRef: "no-matching-rule" });
    expect(
      await simulatedSink(2).deliver({ id: "e", type: "x", occurredAt: "t", data: {} }),
    ).toEqual({ kind: "simulated", evidenceRef: "simulated:2-rules" });
  });
});
