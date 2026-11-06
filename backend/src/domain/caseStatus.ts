export const CASE_STATUSES = [
  "Draft",
  "Intake",
  "Needs Review",
  "Ready",
  "Approved",
  "Closed",
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];
export type CaseRole = "analyst" | "reviewer";

type Transition = { to: CaseStatus; role: CaseRole; reasonRequired?: boolean };

// Mirrors docs/design/STATE-MACHINES.md. Anything not listed is an invalid transition.
const TRANSITIONS: Readonly<Record<CaseStatus, readonly Transition[]>> = {
  Draft: [{ to: "Intake", role: "analyst" }],
  Intake: [{ to: "Needs Review", role: "analyst" }],
  "Needs Review": [{ to: "Ready", role: "reviewer" }],
  Ready: [
    { to: "Approved", role: "reviewer" },
    { to: "Needs Review", role: "reviewer", reasonRequired: true },
  ],
  Approved: [{ to: "Closed", role: "reviewer" }],
  Closed: [{ to: "Needs Review", role: "reviewer", reasonRequired: true }],
};

export type TransitionResult =
  | { ok: true; to: CaseStatus }
  | { ok: false; code: "invalid_transition" | "forbidden_role" | "reason_required" };

export function transitionCase(
  from: CaseStatus,
  to: CaseStatus,
  role: CaseRole,
  reason?: string,
): TransitionResult {
  const rule = TRANSITIONS[from].find((t) => t.to === to);
  if (!rule) return { ok: false, code: "invalid_transition" };
  // A reviewer may also do analyst work. The reverse never holds.
  if (rule.role === "reviewer" && role !== "reviewer") {
    return { ok: false, code: "forbidden_role" };
  }
  if (rule.reasonRequired && !reason?.trim()) return { ok: false, code: "reason_required" };
  return { ok: true, to };
}
