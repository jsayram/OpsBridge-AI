// P5: documents and AI review on the case page. The suggestion is shown beside its source text,
// labeled as fixture or live output, and only a reviewer's decision can change the case.
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ApiFailure, api, type CaseFull, intentKeys } from "../api";
import { ErrorCard } from "../components/ui";
import { useSession } from "../session";
import { useLoad } from "./shared";

type Segment = { id: string; page: number; text: string };
type Citation = { field: string; segmentId: string; page: number; text: string };
type Item = { itemKey: string; state: string };
type Review = {
  id: string;
  status: string;
  version: number;
  mode: "fixture" | "live";
  label: string;
  modelVersion: string;
  promptVersion: string;
  inputSha256: string | null;
  suggestion: {
    documentType: string;
    extractedFields: Record<string, string>;
    uncertainties: { field: string | null; reason: string; segments: string[] }[];
    missingFields: string[];
    reasons: string[];
    abstained: boolean;
  } | null;
  citations: Citation[];
  validation: {
    valid: boolean;
    errors: string[];
    fallback?: { from: string; code: string };
  } | null;
  abstainReason: string | null;
  errorCode: string | null;
  reviewerEdits: Record<string, string | null> | null;
  applied: (Item & { evidenceRef: string })[] | null;
  policy: {
    comparisons: { field: string; extracted: string | null; record: string; outcome: string }[];
    apply: Item[];
    refused: (Item & { code: string })[];
  } | null;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  decisionReason: string | null;
};
type DocumentFull = {
  id: string;
  title: string;
  category: string | null;
  sha256: string | null;
  readOnly: boolean;
  source: string;
  segments: Segment[];
  reviews: Review[];
};
type Preview = { policy: { apply: Item[] }; caseVersion: number };
type Fixture = { fixtureId: string; title: string; category: string; kind: string };

const FIELD_LABELS: Record<string, string> = {
  clientName: "Client name",
  caseNumber: "Case number",
  serviceStart: "Service start",
  serviceEnd: "Service end",
  billingContact: "Billing contact",
  scopeSigned: "Scope signed",
};
const ITEM_LABELS: Record<string, string> = {
  client_contact_confirmed: "Client contact confirmed",
  scope_confirmed: "Scope of work confirmed",
  billing_entity_confirmed: "Billing entity confirmed",
  renewal_terms_confirmed: "Renewal terms confirmed",
  site_access_noted: "Site access noted",
  site_visit_logged: "Site visit logged",
};
// Reasons arrive as closed codes, never document text.
const REASON_TEXT: Record<string, string> = {
  fields_complete: "Every field was found.",
  fields_missing: "Some fields are missing.",
  conflict_found: "The document gives conflicting values.",
  suspicious_instructions_ignored:
    "The document contains text that reads like instructions. It was treated as data and ignored.",
  low_text_quality: "The document looks incomplete.",
  no_extractable_text: "No text could be read: this looks like an image-only scan.",
  ambiguous: "The document is too ambiguous to review.",
  adversarial_content: "The document looks like an attack, so nothing was extracted.",
  missing_required_fields: "Too few fields were found to suggest anything.",
};
const REFUSAL_TEXT: Record<string, string> = {
  not_supported_by_fields: "the extracted fields don't support it",
  not_allowed: "the rules don't allow it here",
  checklist_locked: "the checklist is locked",
  not_on_this_case: "this case has no such item",
  already_set: "it is already set",
  would_downgrade: "it would undo a finished item",
  abstained: "the review abstained",
};
const UNCERTAIN_TEXT: Record<string, string> = {
  conflicting_values: "conflicting values",
  invalid_value: "value failed the field rules",
  ambiguous_label: "unclear label",
  incomplete_document: "document looks incomplete",
};

const itemText = (i: Item) => `${ITEM_LABELS[i.itemKey] ?? i.itemKey}: ${i.state}`;

function Badge({ review }: { review: Review }) {
  return <span className={`badge ${review.mode === "fixture" ? "sim" : ""}`}>{review.label}</span>;
}

function ReviewPanel({
  review,
  caseData,
  onChanged,
}: {
  review: Review;
  caseData: CaseFull;
  onChanged: (message: string) => void;
}) {
  const { state, sessionEnded } = useSession();
  const canDecide = state.status === "ready" && state.me.capabilities.includes("ai:decide");
  const canRetry = state.status === "ready" && state.me.capabilities.includes("ai:request");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState("");
  const keys = useRef(intentKeys()).current;
  const s = review.suggestion;
  const decided = ["Accepted", "Accepted with Edits", "Rejected"].includes(review.status);

  const send = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setFailure(null);
    const intent = JSON.stringify(body);
    try {
      await api(`/ai-reviews/${encodeURIComponent(review.id)}/decision`, {
        method: "POST",
        body,
        idempotencyKey: keys.keyFor(intent),
      });
      keys.settle();
      onChanged(done);
    } catch (e) {
      keys.settle(e);
      if (e instanceof ApiFailure && e.status === 401) sessionEnded();
      else if (e instanceof ApiFailure) setFailure(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api(`/ai-reviews/${encodeURIComponent(review.id)}/retry`, { method: "POST", body: {} });
      onChanged("Review retried.");
    } catch (e) {
      if (e instanceof ApiFailure) setFailure(e);
    } finally {
      setBusy(false);
    }
  };
  const changedEdits = () =>
    Object.fromEntries(
      Object.entries(edits).map(([k, v]) => [k, v.trim() === "" ? null : v.trim()]),
    );
  const ids = (items: Item[]) => items.map((i) => `${i.itemKey}:${i.state}`);
  // Edits can change what the rules allow, so the reviewer sees the new list before accepting.
  const previewEdits = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      setPreview(
        await api<Preview>(`/ai-reviews/${encodeURIComponent(review.id)}/preview`, {
          method: "POST",
          body: { edits: changedEdits() },
        }),
      );
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) sessionEnded();
      else if (err instanceof ApiFailure) setFailure(err);
    } finally {
      setBusy(false);
    }
  };
  const acceptEdits = (p: Preview) =>
    void send(
      {
        decision: "accept_with_edits",
        version: review.version,
        edits: changedEdits(),
        caseVersion: p.caseVersion,
        expectApply: ids(p.policy.apply),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      },
      "Accepted with your edits.",
    );

  return (
    <div className="stack review-panel">
      <p>
        <Badge review={review} /> <strong>{review.status}</strong>{" "}
        <span className="small muted">
          {review.modelVersion}, prompt {review.promptVersion}
          {review.inputSha256 ? `, input ${review.inputSha256.slice(0, 12)}` : ""}
        </span>
      </p>
      {review.validation?.fallback && (
        <p className="small" role="note">
          Live review wasn't used ({review.validation.fallback.code}). This is the labeled fixture
          result instead.
        </p>
      )}
      {review.status === "Failed" && (
        <div role="alert">
          <p>
            This review failed: <span className="mono">{review.errorCode}</span>
            {review.validation && !review.validation.valid
              ? `. Output rejected by validation: ${review.validation.errors.join(", ")}.`
              : "."}{" "}
            Nothing on the case changed.
          </p>
          {canRetry && (
            <button type="button" onClick={() => void retry()} disabled={busy}>
              Retry with the fixture
            </button>
          )}
        </div>
      )}
      {s && (
        <>
          {s.reasons.map((r) => (
            <p key={r} className="small">
              {REASON_TEXT[r] ?? r}
            </p>
          ))}
          {s.abstained ? (
            <p>
              Abstained: <span className="mono">{review.abstainReason}</span>. There is nothing to
              apply; a person decides from the document.
            </p>
          ) : (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the region scrolls, so it needs focus
            <section className="tscroll" tabIndex={0} aria-label="Suggested fields and sources">
              <table className="review-table">
                <caption className="sr-only">Suggested fields and their sources</caption>
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Suggested</th>
                    <th scope="col">Source in the document</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(FIELD_LABELS).map((f) => {
                    const value = s.extractedFields[f];
                    const unsure = s.uncertainties.find((u) => u.field === f);
                    const cites = review.citations.filter((c) => c.field === f);
                    return (
                      <tr key={f}>
                        <th scope="row">{FIELD_LABELS[f]}</th>
                        <td>
                          {value ?? (
                            <span className="muted">
                              {unsure
                                ? `Uncertain: ${UNCERTAIN_TEXT[unsure.reason] ?? unsure.reason}`
                                : "Not in document"}
                            </span>
                          )}
                          {review.reviewerEdits && f in review.reviewerEdits && (
                            <span className="small">
                              {" "}
                              (reviewer: {review.reviewerEdits[f] ?? "removed"})
                            </span>
                          )}
                        </td>
                        <td className="small">
                          {cites.length === 0
                            ? "None"
                            : cites.map((c) => (
                                <span key={c.segmentId} className="cite">
                                  Page {c.page}, <span className="mono">{c.segmentId}</span>: “
                                  {c.text}”
                                </span>
                              ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}
          {review.policy && (
            <div className="small">
              {review.policy.comparisons.map((c) => (
                <p key={c.field}>
                  {FIELD_LABELS[c.field]} compared with this case's client ({c.record}):{" "}
                  <strong>{c.outcome.replaceAll("_", " ")}</strong>
                </p>
              ))}
              <p>
                {review.policy.apply.length
                  ? `On accept, the rules allow: ${review.policy.apply.map(itemText).join("; ")}.`
                  : "On accept, nothing on the case would change."}
              </p>
              {review.policy.refused.map((r) => (
                <p key={r.itemKey}>
                  Not applied: {itemText(r)}, because {REFUSAL_TEXT[r.code] ?? r.code}.
                </p>
              ))}
            </div>
          )}
        </>
      )}
      {decided && (
        <p className="small">
          Decided: {review.status}
          {review.decisionReason ? `, "${review.decisionReason}"` : ""}.{" "}
          {review.applied?.length
            ? `Applied through the checklist command: ${review.applied.map(itemText).join("; ")}.`
            : "Nothing on the case changed."}
        </p>
      )}
      {failure && <ErrorCard failure={failure} />}
      {review.status === "Needs Human Review" && canDecide && !caseData.readOnly && (
        <div className="stack">
          <label className="field">
            Reason (optional)
            <input
              type="text"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void send(
                  {
                    decision: "accept",
                    version: review.version,
                    caseVersion: caseData.version,
                    expectApply: ids(review.policy?.apply ?? []),
                    ...(reason.trim() ? { reason: reason.trim() } : {}),
                  },
                  "Accepted.",
                )
              }
            >
              Accept{review.policy?.apply.length ? ` and apply ${review.policy.apply.length}` : ""}
            </button>
            {s && !s.abstained && (
              <button type="button" disabled={busy} onClick={() => setEditing((v) => !v)}>
                {editing ? "Cancel edits" : "Edit, then accept"}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void send(
                  {
                    decision: "reject",
                    version: review.version,
                    ...(reason.trim() ? { reason: reason.trim() } : {}),
                  },
                  "Rejected. Nothing on the case changed.",
                )
              }
            >
              Reject
            </button>
          </div>
          {editing && s && (
            <form className="stack" onSubmit={(e) => void previewEdits(e)}>
              <p className="small muted">
                Edits are stored beside the suggestion and checked by the same rules. Leave a field
                empty to remove it. Preview shows what an accept would then change.
              </p>
              {Object.keys(FIELD_LABELS).map((f) => (
                <label key={f} className="field">
                  {FIELD_LABELS[f]}
                  <input
                    type="text"
                    maxLength={120}
                    defaultValue={s.extractedFields[f] ?? ""}
                    onChange={(e) => {
                      setPreview(null);
                      setEdits((x) => ({ ...x, [f]: e.target.value }));
                    }}
                  />
                </label>
              ))}
              <div>
                <button type="submit" disabled={busy || !Object.keys(edits).length}>
                  Preview changes
                </button>
              </div>
              {preview && (
                <div className="stack" role="status">
                  <p className="small">
                    {preview.policy.apply.length
                      ? `With these edits, accept applies: ${preview.policy.apply.map(itemText).join("; ")}.`
                      : "With these edits, accept changes nothing on the case."}
                  </p>
                  <div>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => acceptEdits(preview)}
                    >
                      Accept with edits
                      {preview.policy.apply.length
                        ? ` and apply ${preview.policy.apply.length}`
                        : ""}
                    </button>
                  </div>
                </div>
              )}
            </form>
          )}
        </div>
      )}
      {review.status === "Needs Human Review" && !canDecide && (
        <p className="small muted">Only a Manager can decide a review. Switch roles to try it.</p>
      )}
    </div>
  );
}

function DocumentPanel({
  id,
  caseData,
  onCaseChanged,
}: {
  id: string;
  caseData: CaseFull;
  onCaseChanged: (message: string) => void;
}) {
  const { state, sessionEnded } = useSession();
  const { data, failure, reload } = useLoad<DocumentFull>(`/documents/${encodeURIComponent(id)}`);
  const [busy, setBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState<ApiFailure | null>(null);
  const canRequest = state.status === "ready" && state.me.capabilities.includes("ai:request");
  const live = state.status === "ready" && state.me.capabilities.includes("ai:live");

  const request = async (mode: "fixture" | "live") => {
    setBusy(true);
    setActionFailure(null);
    try {
      await api(`/documents/${encodeURIComponent(id)}/review`, { method: "POST", body: { mode } });
      reload();
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) sessionEnded();
      else if (e instanceof ApiFailure) setActionFailure(e);
    } finally {
      setBusy(false);
    }
  };
  if (failure) return <ErrorCard failure={failure} onRetry={reload} />;
  if (!data) return <p role="status">Loading document…</p>;
  const latest = data.reviews[0];
  return (
    <div className="stack">
      <p className="small muted">{data.source}</p>
      <details>
        <summary>Document text ({data.segments.length} segments)</summary>
        {data.segments.length === 0 ? (
          <p className="muted">No text layer. This is an image-only scan, and there is no OCR.</p>
        ) : (
          <ol className="segments small">
            {data.segments.map((s) => (
              <li key={s.id}>
                <span className="mono">
                  p{s.page} {s.id}
                </span>{" "}
                {s.text}
              </li>
            ))}
          </ol>
        )}
      </details>
      {actionFailure && <ErrorCard failure={actionFailure} />}
      {!data.readOnly && canRequest && (
        <div className="row">
          <button type="button" disabled={busy} onClick={() => void request("fixture")}>
            {latest ? "Review again" : "Request review"}
          </button>
          {live && (
            <button type="button" disabled={busy} onClick={() => void request("live")}>
              Live review (owner)
            </button>
          )}
        </div>
      )}
      {latest ? (
        <ReviewPanel
          review={latest}
          caseData={caseData}
          onChanged={(m) => {
            reload();
            onCaseChanged(m);
          }}
        />
      ) : (
        <p className="muted">Not reviewed yet.</p>
      )}
    </div>
  );
}

export function DocumentsSection({
  data,
  onChanged,
  open,
  setOpen,
}: {
  data: CaseFull;
  onChanged: (message: string) => void;
  // Held by the case page, so the open document survives the page reloading after a decision.
  open: string | null;
  setOpen: (id: string | null) => void;
}) {
  const { state, sessionEnded } = useSession();
  const canAttach = state.status === "ready" && state.me.capabilities.includes("documents:attach");
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const keys = useRef(intentKeys()).current;

  useEffect(() => {
    if (!canAttach || data.readOnly) return;
    api<{ items: Fixture[] }>("/fixtures/documents")
      .then((r) => setFixtures(r.items))
      .catch(() => {});
  }, [canAttach, data.readOnly]);
  const groups = useMemo(
    () =>
      ["standard", "messy", "adversarial"].map(
        (c) => [c, fixtures.filter((f) => f.category === c)] as const,
      ),
    [fixtures],
  );

  const attach = async (e: FormEvent) => {
    e.preventDefault();
    if (!pick) return;
    setBusy(true);
    setFailure(null);
    try {
      const doc = await api<{ id: string }>(
        `/cases/${encodeURIComponent(data.id)}/documents/from-fixture`,
        {
          method: "POST",
          body: { fixtureId: pick },
          idempotencyKey: keys.keyFor(pick),
        },
      );
      keys.settle();
      setOpen(doc.id);
      onChanged("Document attached.");
    } catch (err) {
      keys.settle(err);
      if (err instanceof ApiFailure && err.status === 401) sessionEnded();
      else if (err instanceof ApiFailure) setFailure(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="documents-heading">
      <h2 id="documents-heading">Documents and AI review</h2>
      <p className="small muted">
        Every document here is fictional. Reviews in the demo are deterministic fixtures, labeled as
        such; a suggestion changes nothing until a Manager accepts it.
      </p>
      {data.documents.length === 0 ? (
        <p className="muted">No documents yet.</p>
      ) : (
        <ul className="list">
          {data.documents.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                className="link"
                aria-expanded={open === d.id}
                onClick={() => setOpen(open === d.id ? null : d.id)}
              >
                {d.title}
              </button>{" "}
              <span className="small muted">
                {d.category ?? ""} {d.status}
              </span>
              {open === d.id && (
                <DocumentPanel id={d.id} caseData={data} onCaseChanged={onChanged} />
              )}
            </li>
          ))}
        </ul>
      )}
      {failure && <ErrorCard failure={failure} />}
      {canAttach && !data.readOnly && (
        <form className="row" onSubmit={(e) => void attach(e)}>
          <label className="field">
            Attach a fictional document
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose one</option>
              {groups.map(([category, items]) => (
                <optgroup key={category} label={category}>
                  {items.map((f) => (
                    <option key={f.fixtureId} value={f.fixtureId}>
                      {f.title} ({f.kind})
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button type="submit" disabled={busy || !pick}>
            Attach
          </button>
        </form>
      )}
    </section>
  );
}
