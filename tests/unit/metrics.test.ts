import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURE_EVALUATION, GLOSSARY, SNAPSHOT_KEYS } from "../../backend/src/domain/metrics";

describe("P6.1 metric definitions", () => {
  it("the dashboard's evaluation summary is the P5.5 report, word for word on the numbers", () => {
    const r = JSON.parse(readFileSync("docs/evidence/P5.5/eval-report.json", "utf8"));
    expect(FIXTURE_EVALUATION).toMatchObject({
      model: r.model,
      evalVersion: r.evalVersion,
      date: r.date,
      documents: r.fixtureSize.total,
      standardAccuracy: r.metrics.accuracy.standard.normalized,
      messyWithTextAccuracy: r.metrics.accuracy.messyWithText.normalized,
      schemaValid: r.metrics.schemaValidAfterValidation,
      unauthorizedWrites: r.metrics.unauthorizedWritesOrNotifications,
      adversarialOverrides: r.metrics.adversarialOverrides,
      estimatedCostUsd: r.metrics.estimatedCostUsd,
    });
    expect(FIXTURE_EVALUATION.disclosure).toMatch(/Not live-model accuracy/);
  });

  it("every snapshot key and metric has a definition with a formula and a provenance", () => {
    for (const k of SNAPSHOT_KEYS) expect(GLOSSARY[k]).toBeDefined();
    for (const d of Object.values(GLOSSARY)) {
      expect(d.formula.length).toBeGreaterThan(10);
      expect(["SYNTHETIC", "MEASURED_DEMO", "ESTIMATED", "UNKNOWN"]).toContain(d.provenance);
    }
    // Estimates and unknowns are never presented as counted.
    expect(GLOSSARY.manual_steps_avoided?.provenance).toBe("ESTIMATED");
    expect(GLOSSARY.ai_live_cost?.provenance).toBe("UNKNOWN");
  });

  it("the migration's allowed snapshot keys match the code", () => {
    const sql = readFileSync("backend/migrations/0009_analytics.sql", "utf8");
    const m = /metric_key IN\s*\(([^)]*)\)/.exec(sql);
    const keys = [...(m?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(keys).toEqual([...SNAPSHOT_KEYS]);
  });
});
