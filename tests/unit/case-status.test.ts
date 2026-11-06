import { describe, expect, it } from "vitest";
import { CASE_STATUSES, transitionCase } from "../../backend/src/domain/caseStatus";

describe("case state machine", () => {
  it("walks the happy path in order", () => {
    expect(transitionCase("Draft", "Intake", "analyst")).toEqual({ ok: true, to: "Intake" });
    expect(transitionCase("Intake", "Needs Review", "analyst").ok).toBe(true);
    expect(transitionCase("Needs Review", "Ready", "reviewer").ok).toBe(true);
    expect(transitionCase("Ready", "Approved", "reviewer").ok).toBe(true);
    expect(transitionCase("Approved", "Closed", "reviewer").ok).toBe(true);
  });

  it("rejects every transition that is not listed", () => {
    const legal = new Set([
      "Draft>Intake",
      "Intake>Needs Review",
      "Needs Review>Ready",
      "Ready>Approved",
      "Ready>Needs Review",
      "Approved>Closed",
      "Closed>Needs Review",
    ]);
    for (const from of CASE_STATUSES) {
      for (const to of CASE_STATUSES) {
        if (legal.has(`${from}>${to}`)) continue;
        expect(transitionCase(from, to, "reviewer", "reason")).toEqual({
          ok: false,
          code: "invalid_transition",
        });
      }
    }
  });

  it("stops an analyst approving or reopening", () => {
    expect(transitionCase("Ready", "Approved", "analyst")).toEqual({
      ok: false,
      code: "forbidden_role",
    });
    expect(transitionCase("Closed", "Needs Review", "analyst", "new evidence")).toEqual({
      ok: false,
      code: "forbidden_role",
    });
  });

  it("requires a reason to reopen, and blank does not count", () => {
    expect(transitionCase("Closed", "Needs Review", "reviewer")).toEqual({
      ok: false,
      code: "reason_required",
    });
    expect(transitionCase("Closed", "Needs Review", "reviewer", "   ")).toEqual({
      ok: false,
      code: "reason_required",
    });
    expect(transitionCase("Closed", "Needs Review", "reviewer", "client sent new dates").ok).toBe(
      true,
    );
  });
});
