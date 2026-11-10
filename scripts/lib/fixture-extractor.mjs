// The deterministic fixture extractor (P5.2). It runs at build time only: its output for each
// fictional document is stored with the seed, keyed by the document hash and prompt version, and
// the Worker replays it. It is a labeled-line parser, not a language model, and it never sees the
// expected answers. Every output still goes through the Worker's full validation layer.

export const PROMPT_VERSION = "doc-review-v1";
export const FIXTURE_MODEL = "fixture:labeled-line-extractor-v1";

const FIELDS = {
  clientName: ["client name", "client", "customer name"],
  caseNumber: ["case number", "case no", "internal case number"],
  serviceStart: ["service start", "start date"],
  serviceEnd: ["service end", "end date"],
  billingContact: ["billing contact", "billing email"],
  scopeSigned: ["scope signed", "signed scope"],
};
export const FIELD_NAMES = Object.keys(FIELDS);

const DOC_TYPES = {
  "intake sheet": "intake_sheet",
  "service order": "service_order",
  "billing form": "billing_form",
  "renewal notice": "renewal_notice",
};

// Text that reads like an instruction, a role, a link or markup. It is reported and ignored.
const SUSPICIOUS = [
  /\bignore\b.{0,40}\binstructions?\b/i,
  /^\s*(system|assistant|developer|admin(istrator)?)\s*[:>]/i,
  /\byou are now\b/i,
  /\bhttps?:\/\//i,
  /<\/?[a-z][^>]*>/i,
  /["']?(tool|function)["']?\s*[:=]/i,
  /\b(send|email|forward|upload)\b.{0,60}\b(to|@)/i,
  /\b(approve|approved|accepted)\b.{0,40}\b(case|this|by)\b/i,
  /\bmark\b.{0,40}\b(done|complete|checklist)\b/i,
  /\bchange\b.{0,40}\bstatus\b/i,
  /\balso\b.{0,30}\b(mark|set|approve)\b/i,
];
export const isSuspicious = (text) => SUSPICIOUS.some((p) => p.test(text));

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[a.length][b.length];
}

// Exact label first, then a small typo allowance on longer labels.
function fieldFor(label) {
  const l = norm(label);
  if (!l) return null;
  for (const [field, labels] of Object.entries(FIELDS)) if (labels.includes(l)) return field;
  for (const [field, labels] of Object.entries(FIELDS)) {
    if (labels.some((x) => x.length >= 8 && distance(x, l) <= 2)) return field;
  }
  return null;
}

const VALID = {
  clientName: (v) => /^[A-Za-z0-9 .,&'()-]{2,120}$/.test(v) && !isSuspicious(v),
  caseNumber: (v) => /^OB-\d{4}$/.test(v),
  serviceStart: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  serviceEnd: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  billingContact: (v) => /^[a-z0-9._-]{1,40}@example\.com$/.test(v),
  scopeSigned: (v) => /^(yes|no)$/i.test(v),
};
const clean = (field, v) => (field === "scopeSigned" ? v.toLowerCase() : v);

// "Label: value", "Label | value", or a bare label with the value on the next line.
function splitLine(text) {
  const m = /^\s*([^:|]{2,40}?)\s*[:|]\s*(.*)$/.exec(text);
  return m ? { label: m[1], value: m[2].trim() } : null;
}

export function extract(doc) {
  const segments = doc.segments;
  const reasons = new Set();
  const out = {
    schemaVersion: PROMPT_VERSION,
    documentType: "unknown",
    extractedFields: {},
    perFieldSource: {},
    uncertainties: [],
    missingFields: [],
    proposedAction: { kind: "none" },
    abstained: false,
    abstainReason: null,
    reasons: [],
  };
  if (!segments.some((s) => /[A-Za-z]{2}/.test(s.text))) {
    out.abstained = true;
    out.abstainReason = "no_extractable_text";
    out.missingFields = [...FIELD_NAMES];
    out.reasons = ["no_extractable_text"];
    return out;
  }

  const seen = {};
  const invalid = new Set();
  const note = (field, value, segId) => {
    seen[field] ??= [];
    seen[field].push({ value, segId });
  };
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (isSuspicious(seg.text)) reasons.add("suspicious_instructions_ignored");
    const parts = splitLine(seg.text);
    if (parts && norm(parts.label) === "document type") {
      out.documentType = DOC_TYPES[norm(parts.value)] ?? "unknown";
      continue;
    }
    let field = parts?.value ? fieldFor(parts.label) : null;
    let value = parts?.value ?? "";
    let source = seg.id;
    if (!field) {
      // A bare label line: the value is the next segment on the same page.
      const bare = fieldFor(seg.text.replace(/[:|]\s*$/, ""));
      const next = segments[i + 1];
      if (bare && next && next.page === seg.page && !splitLine(next.text)) {
        field = bare;
        value = next.text.trim();
        source = next.id;
        i++;
      }
    }
    if (!field) continue;
    if (!value) continue;
    if (!VALID[field](value)) {
      invalid.add(field);
      continue;
    }
    note(field, clean(field, value), source);
  }

  for (const field of FIELD_NAMES) {
    const values = seen[field] ?? [];
    const distinct = [...new Set(values.map((v) => v.value))];
    if (distinct.length > 1) {
      out.uncertainties.push({
        field,
        reason: "conflicting_values",
        segments: values.map((v) => v.segId),
      });
      reasons.add("conflict_found");
    } else if (distinct.length === 1) {
      out.extractedFields[field] = distinct[0];
      out.perFieldSource[field] = [values[0].segId];
    } else if (invalid.has(field)) {
      out.uncertainties.push({ field, reason: "invalid_value", segments: [] });
    } else {
      out.missingFields.push(field);
    }
  }

  // "Page 1 of 2" with a page missing: say so rather than guess.
  const declared = segments
    .map((s) => /\bpage \d+ of (\d+)\b/i.exec(s.text))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const pages = new Set(segments.map((s) => s.page)).size;
  if (declared.length && Math.max(...declared) > pages) {
    out.uncertainties.push({ field: null, reason: "incomplete_document", segments: [] });
    reasons.add("low_text_quality");
  }

  const got = Object.keys(out.extractedFields).length;
  if (got === 0 && reasons.has("suspicious_instructions_ignored")) {
    out.abstained = true;
    out.abstainReason = "adversarial_content";
  } else if (got <= 2) {
    out.abstained = true;
    out.abstainReason = "missing_required_fields";
  }
  if (out.missingFields.length) reasons.add("fields_missing");
  else if (!out.uncertainties.length) reasons.add("fields_complete");

  if (!out.abstained) {
    const f = out.extractedFields;
    const items = [];
    if (f.scopeSigned === "yes") items.push({ itemKey: "scope_confirmed", state: "done" });
    if (f.scopeSigned === "no") items.push({ itemKey: "scope_confirmed", state: "flagged" });
    if (f.clientName && f.billingContact) {
      items.push({ itemKey: "client_contact_confirmed", state: "done" });
    }
    if (out.documentType === "billing_form" && f.billingContact) {
      items.push({ itemKey: "billing_entity_confirmed", state: "done" });
    }
    if (out.documentType === "renewal_notice" && f.serviceEnd) {
      items.push({ itemKey: "renewal_terms_confirmed", state: "done" });
    }
    if (items.length) out.proposedAction = { kind: "update_checklist", items };
  } else {
    reasons.add(out.abstainReason);
  }
  out.reasons = [...reasons].sort();
  return out;
}
