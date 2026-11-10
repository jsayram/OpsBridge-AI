import type { CaseStatus } from "./caseStatus";

export type ChecklistState = "open" | "flagged" | "done" | "not_applicable";
export const CHECKLIST_STATES: readonly ChecklistState[] = [
  "open",
  "flagged",
  "done",
  "not_applicable",
];

export type ChecklistGateItem = { required: boolean; state: ChecklistState };

type Definition = { key: string; label: string; required: boolean };

const COMMON: readonly Definition[] = [
  { key: "client_contact_confirmed", label: "Client contact confirmed", required: true },
  { key: "scope_confirmed", label: "Scope of work confirmed", required: true },
];

const BY_TYPE: Readonly<Record<string, readonly Definition[]>> = {
  Onboarding: [{ key: "site_access_noted", label: "Site access noted", required: false }],
  Billing: [{ key: "billing_entity_confirmed", label: "Billing entity confirmed", required: true }],
  Renewal: [{ key: "renewal_terms_confirmed", label: "Renewal terms confirmed", required: true }],
  "Field issue": [{ key: "site_visit_logged", label: "Site visit logged", required: false }],
};

// Fixed rules, so no model output or request body can add or drop a prerequisite.
export const checklistFor = (caseType: string): readonly Definition[] => [
  ...COMMON,
  ...(BY_TYPE[caseType] ?? []),
];

// STATE-MACHINES.md: a flagged item may reach review so someone can look at it, but a case
// can't be Ready while one is outstanding.
export function checklistBlocks(to: CaseStatus, items: readonly ChecklistGateItem[]): boolean {
  const required = items.filter((i) => i.required);
  if (to === "Needs Review") return required.some((i) => i.state === "open");
  if (to === "Ready") return required.some((i) => i.state === "open" || i.state === "flagged");
  return false;
}

export const openRequiredCount = (items: readonly ChecklistGateItem[]) =>
  items.filter((i) => i.required && (i.state === "open" || i.state === "flagged")).length;

// Below this state the checklist still decides whether the case can move.
export const checklistEditable = (status: CaseStatus) =>
  status === "Draft" || status === "Intake" || status === "Needs Review";
