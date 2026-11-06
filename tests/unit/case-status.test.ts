import { describe, expect, it } from "vitest";
import { CASE_STATUSES, transitionCase } from "../../backend/src/domain/caseStatus";

describe("case state machine", () => {
  it("walks the happy path in order", () => {
    expect(transitionCase("Draft", "Intake", "analyst", "update")).toEqual({
      ok: true,
      to: "Intake",
    });
    expect(transitionCase("Intake", "Needs Review", "analyst", "update").ok).toBe(true);
    expect(transitionCase("Needs Review", "Ready", "reviewer", "update").ok).toBe(true);
    expect(transitionCase("Ready", "Approved", "reviewer", "approval").ok).toBe(true);
    expect(transitionCase("Approved", "Closed", "reviewer", "update").ok).toBe(true);
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
        expect(transitionCase(from, to, "reviewer", "update", "reason")).toEqual({
          ok: false,
          code: "invalid_transition",
        });
      }
    }
  });

  it("only the approval command reaches Approved", () => {
    expect(transitionCase("Ready", "Approved", "reviewer", "update")).toEqual({
      ok: false,
      code: "wrong_command",
    });
  });

  it("only the reopen command leaves Closed", () => {
    expect(transitionCase("Closed", "Needs Review", "reviewer", "update", "new dates")).toEqual({
      ok: false,
      code: "wrong_command",
    });
  });

  it("stops an analyst approving or reopening", () => {
    expect(transitionCase("Ready", "Approved", "analyst", "approval")).toEqual({
      ok: false,
      code: "forbidden_role",
    });
    expect(transitionCase("Closed", "Needs Review", "analyst", "reopen", "new evidence")).toEqual({
      ok: false,
      code: "forbidden_role",
    });
  });

  it("requires a reason to reopen or return, and blank does not count", () => {
    expect(transitionCase("Closed", "Needs Review", "reviewer", "reopen")).toEqual({
      ok: false,
      code: "reason_required",
    });
    expect(transitionCase("Closed", "Needs Review", "reviewer", "reopen", "   ")).toEqual({
      ok: false,
      code: "reason_required",
    });
    expect(transitionCase("Ready", "Needs Review", "reviewer", "approval", "dates wrong").ok).toBe(
      true,
    );
    expect(
      transitionCase("Closed", "Needs Review", "reviewer", "reopen", "client sent dates").ok,
    ).toBe(true);
  });
});
