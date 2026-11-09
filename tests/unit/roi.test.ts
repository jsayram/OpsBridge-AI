import { describe, expect, it } from "vitest";
import {
  calculate,
  INPUTS,
  type RoiInputs,
  rough,
  SCENARIOS,
  sensitivity,
  usd,
  validate,
} from "../../frontend/src/lib/roi";

const base = SCENARIOS.base;

describe("P6.4 ROI arithmetic (PRD 11.2)", () => {
  it("recalculates the base scenario by hand", () => {
    const r = calculate(base);
    expect(r.exceptions).toBe(40);
    expect(r.baselineMinutes).toBe(6000);
    expect(r.automatedMinutes).toBe(2800);
    expect(r.grossHoursSaved).toBeCloseTo(3200 / 60, 12);
    expect(r.laborValue).toBeCloseTo((3200 / 60) * 35, 9);
    expect(r.modeledAiCost).toBeCloseTo(8, 12);
    expect(r.totalModeledCost).toBeCloseTo(63, 12);
    expect(r.netValue).toBeCloseTo((3200 / 60) * 35 - 63, 9);
    expect(r.roi).toBeCloseTo(((3200 / 60) * 35 - 63) / 63, 9);
    // 8 minutes saved a task at $35 an hour, less $0.02 of AI, covers $55 of fixed cost at 12.
    expect(r.breakEvenTasks).toBe(12);
  });

  it("orders the three scenarios conservative < base < optimistic", () => {
    const [c, b, o] = (["conservative", "base", "optimistic"] as const).map(
      (k) => calculate(SCENARIOS[k]).netValue,
    );
    expect(c).toBeLessThan(b as number);
    expect(b).toBeLessThan(o as number);
  });

  it("leaves ROI empty when the modeled cost is zero, instead of dividing by it", () => {
    const free = { ...base, platformCostPerMonth: 0, automationCostPerMonth: 0, aiCostPerTask: 0 };
    const r = calculate(free);
    expect(r.totalModeledCost).toBe(0);
    expect(r.roi).toBeNull();
    expect(r.netValue).toBeCloseTo(r.laborValue, 12);
    expect(r.breakEvenTasks).toBe(0);
  });

  it("never reports negative hours saved, and has no break-even when review is slower", () => {
    const worse = { ...base, reviewedMinutesPerTask: 20 };
    const r = calculate(worse);
    expect(r.grossHoursSaved).toBe(0);
    expect(r.laborValue).toBe(0);
    expect(r.netValue).toBeCloseTo(-r.totalModeledCost, 12);
    expect(r.roi).toBeCloseTo(-1, 12);
    expect(r.breakEvenTasks).toBeNull();
  });

  it("handles zero tasks and 100% exceptions", () => {
    expect(calculate({ ...base, tasksPerMonth: 0 })).toMatchObject({
      baselineMinutes: 0,
      grossHoursSaved: 0,
      modeledAiCost: 0,
    });
    const all = calculate({ ...base, exceptionRatePct: 100 });
    expect(all.exceptions).toBe(400);
    expect(all.grossHoursSaved).toBe(0);
  });

  it("is deterministic and every single input change moves the result exactly", () => {
    expect(calculate(base)).toEqual(calculate({ ...base }));
    const doubled = calculate({ ...base, tasksPerMonth: 800 });
    expect(doubled.baselineMinutes).toBe(12000);
    expect(doubled.automatedMinutes).toBe(5600);
    const pricier = calculate({ ...base, hourlyLaborCost: 70 });
    expect(pricier.laborValue).toBeCloseTo(calculate(base).laborValue * 2, 9);
  });

  it("validates inputs before calculating", () => {
    expect(validate(base)).toEqual({});
    const bad = { ...base, tasksPerMonth: -1, manualMinutesPerTask: Number.NaN } as RoiInputs;
    expect(Object.keys(validate(bad)).sort()).toEqual(["manualMinutesPerTask", "tasksPerMonth"]);
    expect(validate({ ...base, exceptionRatePct: 101 }).exceptionRatePct).toMatch(/At most/);
  });

  it("ranks sensitivity by swing in net value", () => {
    const s = sensitivity(base);
    expect(s).toHaveLength(INPUTS.length);
    for (let i = 1; i < s.length; i++) {
      expect((s[i - 1] as { swing: number }).swing).toBeGreaterThanOrEqual(
        (s[i] as { swing: number }).swing,
      );
    }
    // Labor cost and minutes dominate; platform cost barely moves a value this size.
    expect(s.slice(0, 3).map((x) => x.key)).toContain("hourlyLaborCost");
    expect(s.at(-1)?.swing).toBeLessThan((s[0] as { swing: number }).swing);
  });

  it("shows two significant figures and no false precision", () => {
    expect(rough(1803.67)).toBe(1800);
    expect(rough(-63)).toBe(-63);
    expect(rough(12345)).toBe(12000);
    expect(usd(1803.67)).toBe("$1,800");
    expect(usd(-1803.67)).toBe("-$1,800");
  });
});
