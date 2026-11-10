// PRD 7.2 exception states, docs/design/STATE-MACHINES.md. A resolved finding never reopens: new
// source evidence opens a new finding that links the old one.
export const FINDING_STATUSES = [
  "Open",
  "Investigating",
  "Proposed",
  "Resolved",
  "Dismissed",
  "Deferred",
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export type FindingDecision = "approve" | "reject" | "defer";

const ADVANCE: Partial<Record<FindingStatus, FindingStatus>> = {
  Open: "Investigating",
  Investigating: "Proposed",
  Deferred: "Open",
};

export const canAdvance = (from: FindingStatus, to: FindingStatus) => ADVANCE[from] === to;

const OPEN_STATES: readonly FindingStatus[] = ["Open", "Investigating", "Proposed"];
export const isOpenState = (s: FindingStatus) => OPEN_STATES.includes(s);

export function decisionTarget(
  from: FindingStatus,
  decision: FindingDecision,
): FindingStatus | null {
  if (decision === "approve") return from === "Proposed" ? "Resolved" : null;
  if (!isOpenState(from)) return null;
  return decision === "reject" ? "Dismissed" : "Deferred";
}

export const MAX_DEFER_DAYS = 90;
