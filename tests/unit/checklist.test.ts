import { describe, expect, it } from "vitest";
import {
  checklistBlocks,
  checklistEditable,
  checklistFor,
  openRequiredCount,
} from "../../backend/src/domain/checklist";

const item = (state: "open" | "flagged" | "done" | "not_applicable", required = true) => ({
  required,
  state,
});

describe("checklist prerequisites", () => {
  it("Needs Review takes answered or flagged, and stops on open", () => {
    expect(checklistBlocks("Needs Review", [item("open")])).toBe(true);
    expect(checklistBlocks("Needs Review", [item("flagged")])).toBe(false);
    expect(checklistBlocks("Needs Review", [item("done"), item("not_applicable")])).toBe(false);
  });
  it("Ready stops on open and on flagged", () => {
    expect(checklistBlocks("Ready", [item("open")])).toBe(true);
    expect(checklistBlocks("Ready", [item("flagged")])).toBe(true);
    expect(checklistBlocks("Ready", [item("done"), item("not_applicable")])).toBe(false);
  });
  it("optional items never block, and other moves have no gate", () => {
    expect(checklistBlocks("Ready", [item("open", false)])).toBe(false);
    expect(checklistBlocks("Needs Review", [item("flagged", false)])).toBe(false);
    expect(checklistBlocks("Approved", [item("open")])).toBe(false);
    expect(checklistBlocks("Closed", [item("open")])).toBe(false);
  });
  it("counts outstanding required items", () => {
    expect(
      openRequiredCount([item("open"), item("flagged"), item("done"), item("open", false)]),
    ).toBe(2);
  });
  it("locks once a case is past review", () => {
    expect(["Draft", "Intake", "Needs Review"].every((s) => checklistEditable(s as never))).toBe(
      true,
    );
    expect(["Ready", "Approved", "Closed"].some((s) => checklistEditable(s as never))).toBe(false);
  });
  it("every case type gets required items, so no case passes the gate with an empty list", () => {
    for (const type of ["Onboarding", "Billing", "Renewal", "Field issue"]) {
      expect(checklistFor(type).filter((d) => d.required).length).toBeGreaterThanOrEqual(2);
    }
  });
});
