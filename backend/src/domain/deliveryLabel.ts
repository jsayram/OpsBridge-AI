export type DispatchState =
  | "pending"
  | "processing"
  | "retry_scheduled"
  | "accepted"
  | "simulated"
  | "dead_letter";

export type DeliveryEvidence = "none" | "provider_accepted" | "confirmed";
export type DeliveryLabel = "Queued" | "Accepted" | "Confirmed" | "Failed" | "Simulated";

// PRD 7.2. Evidence decides Confirmed; an HTTP 200 alone can only ever reach Accepted.
export function deliveryLabel(state: DispatchState, evidence: DeliveryEvidence): DeliveryLabel {
  switch (state) {
    case "pending":
    case "processing":
    case "retry_scheduled":
      return "Queued";
    case "dead_letter":
      return "Failed";
    case "simulated":
      return "Simulated";
    case "accepted":
      if (evidence === "confirmed") return "Confirmed";
      if (evidence === "provider_accepted") return "Accepted";
      throw new Error("accepted dispatch requires provider evidence");
  }
}
