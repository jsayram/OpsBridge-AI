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

export type CaseCommand = "update" | "approval" | "reopen";

type Transition = {
  to: CaseStatus;
  role: CaseRole;
  via: readonly CaseCommand[];
  reasonRequired?: boolean;
};

const UPDATE: readonly CaseCommand[] = ["update"];

// Mirrors docs/design/STATE-MACHINES.md. Anything not listed is an invalid transition.
const TRANSITIONS: Readonly<Record<CaseStatus, readonly Transition[]>> = {
  Draft: [{ to: "Intake", role: "analyst", via: UPDATE }],
  Intake: [{ to: "Needs Review", role: "analyst", via: UPDATE }],
  "Needs Review": [{ to: "Ready", role: "reviewer", via: UPDATE }],
  Ready: [
    { to: "Approved", role: "reviewer", via: ["approval"] },
    { to: "Needs Review", role: "reviewer", via: ["update", "approval"], reasonRequired: true },
  ],
  Approved: [{ to: "Closed", role: "reviewer", via: UPDATE }],
  Closed: [{ to: "Needs Review", role: "reviewer", via: ["reopen"], reasonRequired: true }],
};

export type TransitionResult =
  | { ok: true; to: CaseStatus }
  | {
      ok: false;
      code: "invalid_transition" | "wrong_command" | "forbidden_role" | "reason_required";
    };

export function transitionCase(
  from: CaseStatus,
  to: CaseStatus,
  role: CaseRole,
  command: CaseCommand,
  reason?: string,
): TransitionResult {
  const rule = TRANSITIONS[from].find((t) => t.to === to);
  if (!rule) return { ok: false, code: "invalid_transition" };
  // Approved and reopen each have one path, so a plain update can't skip the audit trail.
  if (!rule.via.includes(command)) return { ok: false, code: "wrong_command" };
  // A reviewer may also do analyst work. The reverse never holds.
  if (rule.role === "reviewer" && role !== "reviewer") {
    return { ok: false, code: "forbidden_role" };
  }
  if (rule.reasonRequired && !reason?.trim()) return { ok: false, code: "reason_required" };
  return { ok: true, to };
}
