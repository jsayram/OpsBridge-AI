import { describe, expect, it } from "vitest";
import { deliveryLabel } from "../../backend/src/domain/deliveryLabel";

describe("delivery label", () => {
  it("never reports more than the evidence shows", () => {
    expect(deliveryLabel("accepted", "provider_accepted")).toBe("Accepted");
    expect(deliveryLabel("accepted", "confirmed")).toBe("Confirmed");
  });

  it("keeps in-flight states as Queued whatever the evidence", () => {
    expect(deliveryLabel("pending", "none")).toBe("Queued");
    expect(deliveryLabel("processing", "none")).toBe("Queued");
    expect(deliveryLabel("retry_scheduled", "provider_accepted")).toBe("Queued");
  });

  it("maps dead letter and simulated", () => {
    expect(deliveryLabel("dead_letter", "none")).toBe("Failed");
    expect(deliveryLabel("simulated", "none")).toBe("Simulated");
  });

  it("refuses an accepted dispatch with no evidence", () => {
    expect(() => deliveryLabel("accepted", "none")).toThrow(/requires provider evidence/);
  });
});
