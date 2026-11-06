// The closed PRD 9.1 event list and envelope, docs/design/event-envelope.schema.json.
export type EventType =
  | "case.created"
  | "case.needs_review"
  | "approval.completed"
  | "reconciliation.resolved"
  | "integration.degraded";

export type EventData = {
  "case.created": { caseRef: string; caseType: string };
  "case.needs_review": { caseRef: string; reason: "intake" | "returned" | "reopened" };
  "approval.completed": { caseRef: string; decision: "approved" | "rejected" };
};

export type WorkspaceMode = "owner" | "demo";

export const eventEnvelope = <T extends keyof EventData>(input: {
  id: string;
  type: T;
  occurredAt: string;
  workspaceMode: WorkspaceMode;
  requestId: string;
  data: EventData[T];
}) => ({ ...input, version: 1 as const });

// A short display reference. Events leave the system later, so they never carry internal IDs.
export async function caseRef(id: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `CASE-${hex.slice(0, 8).toUpperCase()}`;
}
