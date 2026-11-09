// PRD 10.2 step 7: deterministic rules, not model assertions, decide which checklist changes a
// suggestion may make. The rules read only validated field values and the current case.
import type { CaseStatus } from "../domain/caseStatus";
import { checklistEditable } from "../domain/checklist";
import type { Field, ReviewOutput, SuggestedItem } from "./schema";

export type CaseFacts = {
  status: CaseStatus;
  customerName: string;
  checklist: { key: string; state: string }[];
};

export type Comparison = {
  field: Field;
  extracted: string | null;
  record: string;
  outcome: "match" | "mismatch" | "not_in_document";
};

export type PolicyResult = {
  comparisons: Comparison[];
  // Changes the rules allow on this case right now.
  allowed: SuggestedItem[];
  // What would be committed on accept: suggested and allowed, or after edits, allowed.
  apply: SuggestedItem[];
  // Suggested changes the rules refused, with a code each.
  refused: (SuggestedItem & { code: string })[];
};

// Names compare without case, punctuation or the "(fictional)" marker.
export const sameName = (a: string, b: string) => {
  const n = (s: string) =>
    s
      .toLowerCase()
      .replace(/\(fictional\)/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return n(a) === n(b);
};

export function evaluatePolicy(
  output: Pick<ReviewOutput, "documentType" | "proposedAction" | "abstained">,
  fields: Partial<Record<Field, string>>,
  facts: CaseFacts,
  edited: boolean,
): PolicyResult {
  const comparisons: Comparison[] = [
    {
      field: "clientName",
      extracted: fields.clientName ?? null,
      record: facts.customerName,
      outcome: !fields.clientName
        ? "not_in_document"
        : sameName(fields.clientName, facts.customerName)
          ? "match"
          : "mismatch",
    },
  ];
  const clientOk = comparisons[0]?.outcome === "match";
  const clientMismatch = comparisons[0]?.outcome === "mismatch";

  // A document says something about this case only if it names this case's client. Otherwise the
  // one thing it supports is flagging the client contact (independent review, P5).
  const rules: SuggestedItem[] = [];
  if (clientMismatch) rules.push({ itemKey: "client_contact_confirmed", state: "flagged" });
  if (clientOk && fields.scopeSigned === "yes") {
    rules.push({ itemKey: "scope_confirmed", state: "done" });
  }
  if (clientOk && fields.scopeSigned === "no") {
    rules.push({ itemKey: "scope_confirmed", state: "flagged" });
  }
  if (clientOk && fields.billingContact) {
    rules.push({ itemKey: "client_contact_confirmed", state: "done" });
  }
  if (clientOk && fields.billingContact && output.documentType === "billing_form") {
    rules.push({ itemKey: "billing_entity_confirmed", state: "done" });
  }
  const datesOk =
    !fields.serviceStart || !fields.serviceEnd || fields.serviceStart <= fields.serviceEnd;
  if (clientOk && fields.serviceEnd && datesOk && output.documentType === "renewal_notice") {
    rules.push({ itemKey: "renewal_terms_confirmed", state: "done" });
  }

  // A change applies only to an item this case has, while the checklist can still change, and
  // only forward: open to done or flagged, flagged to done. Nothing is reopened or downgraded.
  const editable = checklistEditable(facts.status);
  const current = new Map(facts.checklist.map((i) => [i.key, i.state]));
  const why = (item: SuggestedItem): string | null => {
    if (output.abstained) return "abstained";
    if (!editable) return "checklist_locked";
    const state = current.get(item.itemKey);
    if (state === undefined) return "not_on_this_case";
    if (state === item.state) return "already_set";
    if (state === "done" || state === "not_applicable") return "would_downgrade";
    if (state === "flagged" && item.state === "flagged") return "already_set";
    return null;
  };
  const allowed = rules.filter((r) => why(r) === null);
  const allowedKey = (i: SuggestedItem) =>
    allowed.some((a) => a.itemKey === i.itemKey && a.state === i.state);

  const suggested =
    output.proposedAction.kind === "update_checklist" ? output.proposedAction.items : [];
  const refused = suggested
    .filter((i) => !allowedKey(i))
    .map((i) => ({
      ...i,
      code:
        why(i) ??
        (rules.some((r) => r.itemKey === i.itemKey && r.state === i.state)
          ? "not_allowed"
          : "not_supported_by_fields"),
    }));
  return {
    comparisons,
    allowed,
    apply: edited ? allowed : suggested.filter(allowedKey),
    refused,
  };
}
