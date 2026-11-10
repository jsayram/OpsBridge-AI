// The provider-neutral review contract, version doc-review-v1 (PRD 10.2 step 6). A fixture, a
// test double and a live model all answer in this exact shape, and all go through validate.ts.

export const PROMPT_VERSION = "doc-review-v1";

export const FIELDS = [
  "clientName",
  "caseNumber",
  "serviceStart",
  "serviceEnd",
  "billingContact",
  "scopeSigned",
] as const;
export type Field = (typeof FIELDS)[number];

export const FIELD_LABELS: Record<Field, string> = {
  clientName: "Client name",
  caseNumber: "Case number",
  serviceStart: "Service start",
  serviceEnd: "Service end",
  billingContact: "Billing contact",
  scopeSigned: "Scope signed",
};

export const DOCUMENT_TYPES = [
  "intake_sheet",
  "service_order",
  "billing_form",
  "renewal_notice",
  "unknown",
] as const;

export const UNCERTAINTY_REASONS = [
  "conflicting_values",
  "invalid_value",
  "ambiguous_label",
  "incomplete_document",
] as const;

// The four reasons the database allows (0003). An abstention still reaches Needs Human Review.
export const ABSTAIN_REASONS = [
  "no_extractable_text",
  "ambiguous",
  "adversarial_content",
  "missing_required_fields",
] as const;
export type AbstainReason = (typeof ABSTAIN_REASONS)[number];

// Reasons are closed codes, never free text, so a document can't smuggle prose into the UI.
export const REASONS = [
  "fields_complete",
  "fields_missing",
  "conflict_found",
  "suspicious_instructions_ignored",
  "low_text_quality",
  ...ABSTAIN_REASONS,
] as const;

// Every checklist key in docs/design STATE-MACHINES and backend/src/domain/checklist.ts.
export const CHECKLIST_KEYS = [
  "client_contact_confirmed",
  "scope_confirmed",
  "site_access_noted",
  "billing_entity_confirmed",
  "renewal_terms_confirmed",
  "site_visit_logged",
] as const;
export type ChecklistKey = (typeof CHECKLIST_KEYS)[number];
export const SUGGESTED_STATES = ["done", "flagged"] as const;
export type SuggestedItem = { itemKey: ChecklistKey; state: (typeof SUGGESTED_STATES)[number] };

export type ReviewOutput = {
  schemaVersion: typeof PROMPT_VERSION;
  documentType: (typeof DOCUMENT_TYPES)[number];
  extractedFields: Partial<Record<Field, string>>;
  perFieldSource: Partial<Record<Field, string[]>>;
  uncertainties: {
    field: Field | null;
    reason: (typeof UNCERTAINTY_REASONS)[number];
    segments: string[];
  }[];
  missingFields: Field[];
  proposedAction: { kind: "none" } | { kind: "update_checklist"; items: SuggestedItem[] };
  abstained: boolean;
  abstainReason: AbstainReason | null;
  reasons: (typeof REASONS)[number][];
};

export const OUTPUT_KEYS = [
  "schemaVersion",
  "documentType",
  "extractedFields",
  "perFieldSource",
  "uncertainties",
  "missingFields",
  "proposedAction",
  "abstained",
  "abstainReason",
  "reasons",
] as const;

export type Segment = { id: string; page: number; text: string };
export type Citation = { field: Field; segmentId: string; page: number; text: string };

// Hard bounds on what a provider may return. Larger is rejected, never truncated.
export const MAX_OUTPUT_CHARS = 16_384;

// Field value rules. The same rules check a reviewer's edit (PRD 10.2 step 9).
const URLISH = /(https?:|www\.|\/\/|javascript:|data:)/i;
const MARKUP = /[<>{}`]/;
export const FIELD_RULES: Record<Field, (v: string) => boolean> = {
  clientName: (v) => /^[A-Za-z0-9 .,&'()-]{2,120}$/.test(v),
  caseNumber: (v) => /^OB-\d{4}$/.test(v),
  serviceStart: (v) => isRealDate(v),
  serviceEnd: (v) => isRealDate(v),
  billingContact: (v) => /^[a-z0-9._-]{1,40}@example\.com$/.test(v),
  scopeSigned: (v) => v === "yes" || v === "no",
};

function isRealDate(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export const safeValue = (field: Field, v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 120 &&
  !URLISH.test(v) &&
  !MARKUP.test(v) &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  !/[\u0000-\u001f\u007f]/.test(v) &&
  FIELD_RULES[field](v);
