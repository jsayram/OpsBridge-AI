// PRD 10.2 steps 6 and 7, 10.3: model output is untrusted input. Strict schema first, then every
// citation against the real segments of this document, then consistency. Anything wrong is
// rejected with codes; nothing is repaired or coerced.
import {
  ABSTAIN_REASONS,
  CHECKLIST_KEYS,
  type Citation,
  DOCUMENT_TYPES,
  type Field,
  FIELDS,
  MAX_OUTPUT_CHARS,
  OUTPUT_KEYS,
  PROMPT_VERSION,
  REASONS,
  type ReviewOutput,
  type Segment,
  SUGGESTED_STATES,
  safeValue,
  UNCERTAINTY_REASONS,
} from "./schema";

export const VALIDATION_CHECKS = ["size", "json", "schema", "values", "citations", "consistency"];
export type Validation = { valid: boolean; checks: string[]; errors: string[] };
export type Validated =
  | { ok: true; output: ReviewOutput; citations: Citation[]; validation: Validation }
  | { ok: false; validation: Validation };

const SEGMENT_ID = /^p\d{1,2}-s\d{1,3}$/;
const MAX_ERRORS = 10;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);
const exactKeys = (o: Obj, keys: readonly string[]) => {
  const got = Object.keys(o);
  return got.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
};
const uniq = (a: unknown[]) => new Set(a).size === a.length;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Does this segment support this value? Never a bare substring: "yes" must not match inside
// "eyes", nor OB-1234 inside OB-12345 (independent review, P5).
// - scopeSigned: the segment's value part, after any "label:" or "label |", is exactly yes or no.
// - caseNumber, billingContact: case-sensitive, whole token.
// - Other fields: case-insensitive, whole token.
export function supports(field: Field, value: string, text: string): boolean {
  const t = squash(text);
  if (field === "scopeSigned") {
    const part = t.includes(":") || t.includes("|") ? (t.split(/[:|]/).pop() ?? "") : t;
    return part.trim().toLowerCase() === value;
  }
  const flags = field === "caseNumber" || field === "billingContact" ? "" : "i";
  return new RegExp(
    `(^|[^A-Za-z0-9@._-])${escapeRegExp(squash(value))}($|[^A-Za-z0-9@_-]|\\.(?![A-Za-z0-9]))`,
    flags,
  ).test(t);
}

export function validateOutput(raw: unknown, segments: readonly Segment[]): Validated {
  const errors: string[] = [];
  const checks: string[] = [];
  const fail = () => ({
    ok: false as const,
    validation: { valid: false, checks, errors: errors.slice(0, MAX_ERRORS) },
  });
  const err = (code: string) => {
    if (!errors.includes(code)) errors.push(code);
  };

  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_OUTPUT_CHARS) {
    err("output_size");
    return fail();
  }
  checks.push("size");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    err("not_json");
    return fail();
  }
  checks.push("json");

  if (!isObj(parsed)) {
    err("not_object");
    return fail();
  }
  for (const k of Object.keys(parsed)) if (!oneOf(OUTPUT_KEYS, k)) err("unknown_key");
  for (const k of OUTPUT_KEYS) if (!Object.hasOwn(parsed, k)) err("missing_key");
  if (errors.length) return fail();
  const o = parsed as Obj;
  if (o.schemaVersion !== PROMPT_VERSION) err("schema_version");
  if (!oneOf(DOCUMENT_TYPES, o.documentType)) err("document_type");
  if (!isObj(o.extractedFields)) err("extracted_fields");
  if (!isObj(o.perFieldSource)) err("per_field_source");
  if (!Array.isArray(o.uncertainties) || o.uncertainties.length > 12) err("uncertainties");
  if (!Array.isArray(o.missingFields) || !uniq(o.missingFields)) err("missing_fields");
  if (typeof o.abstained !== "boolean") err("abstained");
  if (o.abstainReason !== null && !oneOf(ABSTAIN_REASONS, o.abstainReason)) err("abstain_reason");
  if (!Array.isArray(o.reasons) || o.reasons.length > 10 || !uniq(o.reasons)) err("reasons");
  if (errors.length) return fail();

  const fields = o.extractedFields as Obj;
  const sources = o.perFieldSource as Obj;
  const uncertainties = o.uncertainties as unknown[];
  const missing = o.missingFields as unknown[];
  const reasons = o.reasons as unknown[];
  for (const k of Object.keys(fields)) if (!oneOf(FIELDS, k)) err("unknown_field");
  for (const k of Object.keys(sources)) if (!oneOf(FIELDS, k)) err("unknown_field");
  for (const m of missing) if (!oneOf(FIELDS, m)) err("unknown_field");
  for (const r of reasons) if (!oneOf(REASONS, r)) err("unknown_reason");
  for (const u of uncertainties) {
    if (
      !isObj(u) ||
      !exactKeys(u, ["field", "reason", "segments"]) ||
      !(u.field === null || oneOf(FIELDS, u.field)) ||
      !oneOf(UNCERTAINTY_REASONS, u.reason) ||
      !Array.isArray(u.segments) ||
      u.segments.length > 5 ||
      !u.segments.every((s) => typeof s === "string" && SEGMENT_ID.test(s))
    ) {
      err("uncertainty_shape");
    }
  }
  const action = o.proposedAction;
  if (!isObj(action) || !oneOf(["none", "update_checklist"] as const, action.kind)) {
    err("proposed_action");
  } else if (action.kind === "none") {
    if (!exactKeys(action, ["kind"])) err("proposed_action");
  } else if (
    !exactKeys(action, ["kind", "items"]) ||
    !Array.isArray(action.items) ||
    action.items.length < 1 ||
    action.items.length > CHECKLIST_KEYS.length ||
    !uniq(action.items.map((i) => (isObj(i) ? i.itemKey : i))) ||
    !action.items.every(
      (i) =>
        isObj(i) &&
        exactKeys(i, ["itemKey", "state"]) &&
        oneOf(CHECKLIST_KEYS, i.itemKey) &&
        oneOf(SUGGESTED_STATES, i.state),
    )
  ) {
    err("proposed_action");
  }
  if (errors.length) return fail();
  checks.push("schema");

  for (const [k, v] of Object.entries(fields)) if (!safeValue(k as Field, v)) err("invalid_value");
  if (errors.length) return fail();
  checks.push("values");

  // Every extracted field cites 1 to 3 real segments, and its value appears in one of them.
  const byId = new Map(segments.map((s) => [s.id, s]));
  const citations: Citation[] = [];
  const fieldKeys = Object.keys(fields) as Field[];
  if (Object.keys(sources).length !== fieldKeys.length) err("citation_missing");
  for (const field of fieldKeys) {
    const ids = sources[field];
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 3 ||
      !uniq(ids) ||
      !ids.every((s) => typeof s === "string" && SEGMENT_ID.test(s))
    ) {
      err("citation_missing");
      continue;
    }
    const cited = ids.map((id) => byId.get(id as string));
    if (cited.some((s) => !s)) {
      err("unknown_segment");
      continue;
    }
    const value = fields[field] as string;
    if (!cited.some((s) => supports(field, value, (s as Segment).text))) {
      err("unsupported_citation");
      continue;
    }
    for (const s of cited as Segment[]) {
      citations.push({ field, segmentId: s.id, page: s.page, text: s.text });
    }
  }
  for (const u of uncertainties as { segments: string[] }[]) {
    if (u.segments.some((id) => !byId.has(id))) err("unknown_segment");
  }
  if (errors.length) return fail();
  checks.push("citations");

  // A field is extracted, uncertain or missing, never two of them. An abstention proposes nothing.
  const flagged = (uncertainties as { field: Field | null }[]).map((u) => u.field).filter(Boolean);
  if (missing.some((m) => fieldKeys.includes(m as Field))) err("field_state_conflict");
  if (flagged.some((f) => fieldKeys.includes(f as Field))) err("field_state_conflict");
  if (o.abstained !== (o.abstainReason !== null)) err("abstain_mismatch");
  if (o.abstained && (action as Obj).kind !== "none") err("abstain_with_action");
  if (segments.length === 0 && (!o.abstained || o.abstainReason !== "no_extractable_text")) {
    err("must_abstain_no_text");
  }
  if (errors.length) return fail();
  checks.push("consistency");

  return {
    ok: true,
    output: o as unknown as ReviewOutput,
    citations,
    validation: { valid: true, checks, errors: [] },
  };
}
