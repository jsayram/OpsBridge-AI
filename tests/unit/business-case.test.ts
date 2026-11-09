import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculate, SCENARIOS, sensitivity, usd } from "../../frontend/src/lib/roi";

// P6.5 / P6-G: every figure in the business case traces to the ROI module or the metric spec.
const doc = readFileSync("docs/EXECUTIVE-BUSINESS-CASE.md", "utf8");

describe("P6.5 business case figures", () => {
  it.each(["conservative", "base", "optimistic"] as const)("%s row matches the calculator", (k) => {
    const r = calculate(SCENARIOS[k]);
    const name = k[0]?.toUpperCase() + k.slice(1);
    const row = doc.split("\n").find((l) => l.startsWith(`| ${name} |`));
    expect(row).toBeDefined();
    const cells = (row as string).split("|").map((c) => c.trim().replace(/\*/g, ""));
    expect(cells[2]).toBe(String(Math.round(r.grossHoursSaved)));
    expect(cells[3]).toBe(usd(r.laborValue));
    expect(cells[4]).toBe(usd(r.totalModeledCost));
    expect(cells[5]).toBe(usd(r.netValue));
  });

  it("break-even and the conservative loss are stated as the calculator gives them", () => {
    expect(calculate(SCENARIOS.base).breakEvenTasks).toBe(12);
    expect(doc).toContain("breaks even at 12 tasks a month");
    expect(calculate(SCENARIOS.conservative).breakEvenTasks).toBeNull();
  });

  it("the top four sensitivities and their ranges are the calculator's", () => {
    const top = sensitivity(SCENARIOS.base).slice(0, 4);
    for (const s of top) {
      expect(doc).toContain(`${s.label}: ${usd(s.low)} to ${usd(s.high)}`);
    }
  });

  it("labels every figure as illustrative and claims no real result", () => {
    expect(doc).toContain("illustrative projection using synthetic workload");
    expect(doc).toMatch(/No adoption, feedback or approval from real people is claimed/);
    for (const key of [
      "automation_failed",
      "ai_decision_minutes",
      "manual_steps_avoided",
      "ai_live_cost",
    ]) {
      expect(doc).toContain(key);
    }
  });
});
