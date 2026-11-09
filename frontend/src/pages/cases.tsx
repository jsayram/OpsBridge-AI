import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  type ActivityRow,
  ApiFailure,
  type Assignee,
  api,
  type CaseFull,
  type CaseRow,
  type ChecklistItem,
  type Customer,
  intentKeys,
} from "../api";
import { ErrorCard, Skeleton, StatusChip } from "../components/ui";
import { Link, navigate, useRouteFocus } from "../router";
import { can, useSession } from "../session";
import { DocumentsSection } from "./review";
import { day, Head, STATUSES, useLoad } from "./shared";

const QUEUES = ["Field Services", "Seasonal Staffing"];
const CASE_TYPES = ["Onboarding", "Billing", "Renewal", "Field issue"];
const CHECK_STATES: [string, string][] = [
  ["open", "Open"],
  ["flagged", "Flagged"],
  ["done", "Done"],
  ["not_applicable", "Not applicable"],
];

const toIso = (date: string) => new Date(`${date}T12:00:00Z`).toISOString();

function useResetKey() {
  const { state } = useSession();
  return state.status === "ready" && state.me.kind === "guest" ? state.me.expiresAt : "";
}

function useCapability(capability: string) {
  const { state } = useSession();
  return state.status === "ready" && can(state.me, capability);
}

function CreateCase({ onClose }: { onClose: () => void }) {
  const { sessionEnded } = useSession();
  const { data } = useLoad<{ items: Customer[] }>("/customers");
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef(intentKeys()).current;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const due = String(form.get("dueAt") ?? "");
    const body = {
      title: form.get("title"),
      customerId: form.get("customerId"),
      caseType: form.get("caseType"),
      queue: form.get("queue"),
      ...(due ? { dueAt: toIso(due) } : {}),
    };
    setBusy(true);
    setFailure(null);
    try {
      const made = await api<CaseRow>("/cases", {
        method: "POST",
        idempotencyKey: keys.keyFor(JSON.stringify(body)),
        body,
      });
      keys.settle();
      navigate(`/app/cases/${made.id}`);
    } catch (err) {
      keys.settle(err);
      if (err instanceof ApiFailure && err.status === 401) sessionEnded();
      else if (err instanceof ApiFailure) setFailure(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>New case</h2>
      <form onSubmit={(e) => void submit(e)} className="stack">
        <div className="form-grid">
          <label className="field">
            Case title
            <input name="title" type="text" required maxLength={200} />
          </label>
          <label className="field">
            Client
            <select name="customerId" required>
              {data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Case type
            <select name="caseType">
              {CASE_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Queue
            <select name="queue">
              {QUEUES.map((q) => (
                <option key={q}>{q}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Due date (optional)
            <input name="dueAt" type="date" />
          </label>
        </div>
        <div className="actions">
          <button type="submit" className="primary" disabled={busy || !data}>
            Create case
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
        {failure && <ErrorCard failure={failure} />}
      </form>
    </section>
  );
}

export function Cases() {
  useRouteFocus("Cases");
  const { sessionEnded } = useSession();
  const resetKey = useResetKey();
  const canCreate = useCapability("cases:edit");
  const [status, setStatus] = useState("");
  const [queue, setQueue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [overdue, setOverdue] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [items, setItems] = useState<CaseRow[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [nonce, setNonce] = useState(0);
  const people = useLoad<{ items: Assignee[] }>("/assignees");
  const reloadPeople = people.reload;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a reset means a new workspace
  useEffect(() => reloadPeople(), [resetKey, reloadPeople]);

  const fetchPage = useCallback(
    async (after: string | undefined, signal?: AbortSignal) => {
      const q = new URLSearchParams({ limit: "25" });
      if (status) q.set("status", status);
      if (queue) q.set("queue", queue);
      if (assignee) q.set("assignee", assignee);
      if (overdue) q.set("overdue", "true");
      if (search) q.set("q", search);
      if (after) q.set("cursor", after);
      try {
        const page = await api<{ items: CaseRow[]; nextCursor?: string }>(`/cases?${q}`, {
          ...(signal ? { signal } : {}),
        });
        setItems((old) => (after && old ? [...old, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 401) sessionEnded();
        else if (e instanceof ApiFailure) setFailure(e);
      }
    },
    [status, queue, assignee, overdue, search, sessionEnded],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce and reset force a reload
  useEffect(() => {
    const controller = new AbortController();
    setItems(null);
    setFailure(null);
    void fetchPage(undefined, controller.signal);
    return () => controller.abort();
  }, [fetchPage, nonce, resetKey]);

  const clear = () => {
    setStatus("");
    setQueue("");
    setAssignee("");
    setOverdue(false);
    setSearch("");
  };

  return (
    <>
      <Head title="Cases" route="/app/cases" />
      <div className="filters">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(String(new FormData(e.currentTarget).get("q") ?? "").trim());
          }}
        >
          <label className="field">
            Search title or client
            <input key={search} name="q" type="search" defaultValue={search} maxLength={100} />
          </label>
          <button type="submit">Search</button>
        </form>
        <label className="field">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Queue
          <select value={queue} onChange={(e) => setQueue(e.target.value)}>
            <option value="">All queues</option>
            {QUEUES.map((q) => (
              <option key={q}>{q}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Assignee
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {people.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />
          Overdue only
        </label>
        {canCreate && !creating && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            New case
          </button>
        )}
      </div>
      {creating && <CreateCase onClose={() => setCreating(false)} />}
      <p className="sr-only" role="status">
        {items ? `${items.length} cases shown.` : ""}
      </p>
      {failure && <ErrorCard failure={failure} onRetry={() => setNonce((n) => n + 1)} />}
      {!items && !failure && <Skeleton label="Loading cases" />}
      {items?.length === 0 && (
        <section className="card state-panel">
          <h2>No cases match</h2>
          <button type="button" onClick={clear}>
            Clear filter
          </button>
        </section>
      )}
      {items && items.length > 0 && (
        <section className="card" aria-label="Case list">
          <div className="tscroll">
            <table className="min">
              <thead>
                <tr>
                  <th scope="col">Case</th>
                  <th scope="col">Client</th>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Assignee</th>
                  <th scope="col">Due</th>
                  <th scope="col">Age</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">
                      <Link to={`/app/cases/${c.id}`} className="row-link">
                        {c.title}
                      </Link>
                    </th>
                    <td>{c.customer}</td>
                    <td>{c.caseType}</td>
                    <td>
                      <StatusChip status={c.status} />
                    </td>
                    <td>{c.assignee ?? `${c.queue} queue`}</td>
                    <td>
                      {day(c.dueAt)}
                      {c.overdue && <span className="err"> Overdue</span>}
                    </td>
                    <td className="num">{c.ageDays} d</td>
                    <td>{c.readOnly ? "Shared, read-only" : "Yours"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cursor && (
            <button type="button" onClick={() => void fetchPage(cursor)}>
              Load more
            </button>
          )}
        </section>
      )}
    </>
  );
}

type Move = {
  label: string;
  to: string;
  capability: string;
  needsReason?: boolean;
  reopen?: boolean;
};

const MOVES: Record<string, Move[]> = {
  Draft: [{ label: "Move to Intake", to: "Intake", capability: "cases:edit" }],
  Intake: [{ label: "Send to review", to: "Needs Review", capability: "cases:edit" }],
  "Needs Review": [{ label: "Mark Ready", to: "Ready", capability: "cases:review" }],
  Ready: [
    {
      label: "Return to review",
      to: "Needs Review",
      capability: "cases:review",
      needsReason: true,
    },
  ],
  Approved: [{ label: "Close case", to: "Closed", capability: "cases:review" }],
  Closed: [
    {
      label: "Reopen case",
      to: "Needs Review",
      capability: "cases:reopen",
      needsReason: true,
      reopen: true,
    },
  ],
};

const REVIEW_ONLY = "Needs the Manager role. Switch role to try it.";
const EDIT_ONLY = "Needs the Analyst or Manager role.";

function Activity({ id, version }: { id: string; version: number }) {
  const [items, setItems] = useState<ActivityRow[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  const load = useCallback(
    async (after?: string) => {
      try {
        const q = after ? `?cursor=${after}` : "";
        const page = await api<{ items: ActivityRow[]; nextCursor?: string }>(
          `/cases/${encodeURIComponent(id)}/activity${q}`,
        );
        setItems((old) => (after && old ? [...old, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        if (e instanceof ApiFailure) setFailure(e);
      }
    },
    [id],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version means new history
  useEffect(() => {
    void load();
  }, [load, version]);

  return (
    <section className="card">
      <h2>Activity</h2>
      {failure && <ErrorCard failure={failure} />}
      {items?.length === 0 && <p className="muted">No activity recorded for this case yet.</p>}
      {items && items.length > 0 && (
        <ol className="timeline">
          {items.map((a) => (
            <li key={a.id}>
              <strong>{a.action}</strong> by {a.actor}
              {a.summary ? `: ${a.summary}` : ""}{" "}
              <time dateTime={a.occurredAt}>{new Date(a.occurredAt).toLocaleString()}</time>
            </li>
          ))}
        </ol>
      )}
      {cursor && (
        <button type="button" onClick={() => void load(cursor)}>
          Load older activity
        </button>
      )}
    </section>
  );
}

function ChecklistSection({
  data,
  canEdit,
  act,
  busy,
}: {
  data: CaseFull;
  canEdit: boolean;
  act: (run: () => Promise<unknown>, done: string) => Promise<void>;
  busy: boolean;
}) {
  const locked = !["Draft", "Intake", "Needs Review"].includes(data.status);
  const editable = canEdit && !data.readOnly && !locked;
  const update = (item: ChecklistItem, state: string) =>
    act(
      () =>
        api(`/cases/${encodeURIComponent(data.id)}/checklist/${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          body: { state, version: item.version },
        }),
      `${item.label} updated.`,
    );
  return (
    <section className="card">
      <h2>Checklist</h2>
      {data.checklist.length === 0 && <p className="muted">No checklist on this case.</p>}
      {locked && !data.readOnly && data.checklist.length > 0 && (
        <p className="small muted">The checklist is locked once a case is Ready.</p>
      )}
      <ul className="list">
        {data.checklist.map((item) => (
          <li key={item.id} className="check-row">
            <span>
              {item.label} {item.required ? "(required)" : "(optional)"}
            </span>
            <label>
              <span className="sr-only">State of {item.label}</span>
              <select
                value={item.state}
                disabled={!editable || busy}
                onChange={(e) => void update(item, e.target.value)}
              >
                {CHECK_STATES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </li>
        ))}
      </ul>
      {!canEdit && !data.readOnly && <p className="small muted">{EDIT_ONLY}</p>}
    </section>
  );
}

function HandoffSection({
  data,
  act,
  busy,
}: {
  data: CaseFull;
  act: (run: () => Promise<unknown>, done: string) => Promise<void>;
  busy: boolean;
}) {
  const canHand = useCapability("cases:handoff");
  const people = useLoad<{ items: Assignee[] }>("/assignees");
  const stock = useLoad<{ items: { id: string; code: string; description: string }[] }>(
    "/inventory?limit=25",
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const target = String(form.get("target") ?? "");
    const due = String(form.get("dueAt") ?? "");
    const item = String(form.get("inventoryItemId") ?? "");
    void act(
      () =>
        api(`/cases/${encodeURIComponent(data.id)}/handoffs`, {
          method: "POST",
          body: {
            ...(target.startsWith("queue:")
              ? { toQueue: target.slice(6) }
              : { toAssigneeId: target }),
            reason: form.get("reason"),
            ...(due ? { dueAt: toIso(due) } : {}),
            ...(item ? { inventoryItemId: item } : {}),
            expectedCaseVersion: data.version,
          },
        }),
      "Case handed off.",
    ).then(() => formEl.reset());
  };
  return (
    <section className="card">
      <h2>Handoff</h2>
      {data.handoffs.length > 0 ? (
        <ol className="timeline">
          {data.handoffs.map((h) => (
            <li key={h.id}>
              To {h.toAssignee ?? `${h.toQueue} queue`}: {h.reason}
              {h.openRequired > 0 ? ` (${h.openRequired} required item open)` : ""}
              {h.itemCode ? ` Inventory reference ${h.itemCode}.` : ""}{" "}
              <time dateTime={h.occurredAt}>{new Date(h.occurredAt).toLocaleString()}</time>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No handoffs yet.</p>
      )}
      {!data.readOnly && data.status !== "Closed" && canHand && (
        <form onSubmit={submit} className="stack">
          <div className="form-grid">
            <label className="field">
              Hand off to
              <select name="target" required defaultValue="">
                <option value="" disabled>
                  Choose a person or queue
                </option>
                {people.data?.items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {QUEUES.map((q) => (
                  <option key={q} value={`queue:${q}`}>
                    {q} queue
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              New due date (optional)
              <input name="dueAt" type="date" />
            </label>
            <label className="field">
              Inventory reference (optional)
              <select name="inventoryItemId" defaultValue="">
                <option value="">None</option>
                {stock.data?.items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.code}, {i.description}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            Handoff reason
            <textarea name="reason" required maxLength={500} />
          </label>
          <div>
            <button type="submit" disabled={busy}>
              Hand off
            </button>
          </div>
        </form>
      )}
      {!data.readOnly && !canHand && <p className="small muted">{EDIT_ONLY}</p>}
    </section>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  crm_simulator: "CRM (simulated)",
  erp_simulator: "ERP Simulator",
  salesforce_test: "Salesforce test org",
};

function SourceReferencesSection({ refs }: { refs: CaseFull["sourceReferences"] }) {
  return (
    <section className="card">
      <h2>Source references</h2>
      <p className="small muted">What source systems hold for this client. Read-only.</p>
      {refs.links.length === 0 ? (
        <p className="muted">No source record is mapped to this client yet.</p>
      ) : (
        <ul className="list">
          {refs.links.map((l) => (
            <li key={`${l.provider}-${l.externalId}`}>
              {SOURCE_LABEL[l.provider] ?? l.provider} <span className="mono">{l.externalId}</span>
              {l.role === "erp_bill_to" ? ", bill-to" : ""}
            </li>
          ))}
        </ul>
      )}
      {refs.openFindings.length > 0 && (
        <p>
          <Link to={`/app/reconciliation/${refs.openFindings[0]?.id}`}>
            {refs.openFindings.length} open finding{refs.openFindings.length === 1 ? "" : "s"} on
            this client
          </Link>
        </p>
      )}
    </section>
  );
}

function WorkflowSection({
  data,
  act,
  busy,
}: {
  data: CaseFull;
  act: (run: () => Promise<unknown>, done: string) => Promise<void>;
  busy: boolean;
}) {
  const { state } = useSession();
  const [reason, setReason] = useState("");
  const keys = useRef(intentKeys()).current;
  const allowed = (capability: string) => state.status === "ready" && can(state.me, capability);
  const canDecide = allowed("approvals:decide");
  const pending = data.approval?.status === "pending" ? data.approval : null;
  const moves = MOVES[data.status] ?? [];
  const showReason = pending
    ? canDecide
    : moves.some((m) => m.needsReason && allowed(m.capability));

  const move = (m: Move) =>
    act(
      () =>
        m.reopen
          ? api(`/cases/${encodeURIComponent(data.id)}/reopen`, {
              method: "POST",
              body: { reason, version: data.version },
            })
          : api(`/cases/${encodeURIComponent(data.id)}`, {
              method: "PATCH",
              body: {
                status: m.to,
                version: data.version,
                ...(m.needsReason ? { reason } : {}),
              },
            }),
      `Case moved to ${m.to}.`,
    ).then(() => setReason(""));

  const decide = (decision: "approve" | "reject") =>
    pending &&
    act(
      async () => {
        const body = {
          decision,
          caseVersion: data.version,
          ...(decision === "reject" ? { reason } : {}),
        };
        try {
          await api(`/approvals/${encodeURIComponent(pending.id)}/decision`, {
            method: "POST",
            idempotencyKey: keys.keyFor(`${pending.id}:${JSON.stringify(body)}`),
            body,
          });
          keys.settle();
        } catch (e) {
          keys.settle(e);
          throw e;
        }
      },
      decision === "approve" ? "Approved." : "Rejected and returned to review.",
    ).then(() => setReason(""));

  return (
    <section className="card stack">
      <h2>Next step</h2>
      {showReason && (
        <label className="field">
          Reason
          <textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
      <div className="actions">
        {pending && (
          <>
            <button
              type="button"
              className="primary"
              disabled={!canDecide || busy}
              onClick={() => void decide("approve")}
            >
              Approve
            </button>
            <button
              type="button"
              disabled={!canDecide || busy || !reason.trim()}
              onClick={() => void decide("reject")}
            >
              Reject
            </button>
          </>
        )}
        {moves.map((m) => (
          <button
            key={m.label}
            type="button"
            disabled={!allowed(m.capability) || busy || (m.needsReason && !reason.trim())}
            onClick={() => void move(m)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {pending && !canDecide && <p className="small muted">{REVIEW_ONLY}</p>}
      {!pending && moves.some((m) => !allowed(m.capability)) && (
        <p className="small muted">
          {moves.some((m) => m.capability === "cases:edit") ? EDIT_ONLY : REVIEW_ONLY}
        </p>
      )}
      {!pending && moves.length === 0 && <p className="muted">Nothing is waiting on this case.</p>}
    </section>
  );
}

export function CaseDetail({ id }: { id: string }) {
  useRouteFocus("Case");
  const { state, sessionEnded } = useSession();
  const { data, failure, reload } = useLoad<CaseFull>(`/cases/${encodeURIComponent(id)}`);
  const [title, setTitle] = useState("");
  const [actionFailure, setActionFailure] = useState<ApiFailure | null>(null);
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [openDoc, setOpenDoc] = useState<string | null>(null);

  useEffect(() => {
    if (data) setTitle(data.title);
  }, [data]);

  const act = useCallback(
    async (run: () => Promise<unknown>, done: string) => {
      setBusy(true);
      setActionFailure(null);
      setSaved("");
      try {
        await run();
        setSaved(done);
        reload();
      } catch (err) {
        if (err instanceof ApiFailure && err.status === 401) sessionEnded();
        else if (err instanceof ApiFailure) setActionFailure(err);
        else throw err;
      } finally {
        setBusy(false);
      }
    },
    [reload, sessionEnded],
  );

  const canEdit = state.status === "ready" && can(state.me, "cases:edit");
  const locked = data ? ["Ready", "Approved", "Closed"].includes(data.status) : false;

  if (failure) {
    return (
      <>
        <Head title="Case" route="/app/cases/:id" />
        {failure.status === 404 ? (
          <section className="card state-panel" role="alert">
            <h2>Case not found</h2>
            <p className="muted">It doesn't exist in this workspace.</p>
            <Link to="/app/cases" className="button">
              Back to cases
            </Link>
          </section>
        ) : (
          <ErrorCard failure={failure} onRetry={reload} />
        )}
      </>
    );
  }
  if (!data) return <Skeleton label="Loading case" />;
  return (
    <>
      <Head title={data.title} route="/app/cases/:id" />
      <div className="stack">
        <section className="card">
          <dl className="facts">
            <div>
              <dt className="small muted">Client</dt>
              <dd>{data.customer}</dd>
            </div>
            <div>
              <dt className="small muted">Status</dt>
              <dd>
                <StatusChip status={data.status} />
              </dd>
            </div>
            <div>
              <dt className="small muted">Assignee</dt>
              <dd>{data.assignee ?? "Unassigned"}</dd>
            </div>
            <div>
              <dt className="small muted">Queue</dt>
              <dd>{data.queue}</dd>
            </div>
            <div>
              <dt className="small muted">Due</dt>
              <dd>
                {day(data.dueAt)}
                {data.overdue && <span className="err"> Overdue</span>}
              </dd>
            </div>
            <div>
              <dt className="small muted">Age</dt>
              <dd>{data.ageDays} days</dd>
            </div>
          </dl>
        </section>
        <p role="status" className="small muted">
          {saved}
        </p>
        {actionFailure && (
          <ErrorCard
            failure={actionFailure}
            {...(actionFailure.code === "stale_version"
              ? {
                  onRetry: () => {
                    setActionFailure(null);
                    reload();
                  },
                  retryLabel: "Reload",
                }
              : {})}
          />
        )}
        {data.readOnly ? (
          <section className="card">
            <h2>Next step</h2>
            <p className="muted">Shared sample case, read-only for every visitor.</p>
          </section>
        ) : (
          <WorkflowSection data={data} act={act} busy={busy} />
        )}
        <ChecklistSection data={data} canEdit={canEdit} act={act} busy={busy} />
        <HandoffSection data={data} act={act} busy={busy} />
        <SourceReferencesSection refs={data.sourceReferences} />
        <DocumentsSection
          data={data}
          open={openDoc}
          setOpen={setOpenDoc}
          onChanged={(message) => {
            setSaved(message);
            reload();
          }}
        />
        {!data.readOnly && <Activity id={data.id} version={data.version} />}
        <section className="card">
          <h2>Rename</h2>
          {data.readOnly ? (
            <p className="muted">Shared sample case, read-only for every visitor.</p>
          ) : locked ? (
            <p className="muted">Details are locked from Ready on. Return it to review first.</p>
          ) : canEdit ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  () =>
                    api(`/cases/${encodeURIComponent(id)}`, {
                      method: "PATCH",
                      body: { title, version: data.version },
                    }),
                  "Saved.",
                );
              }}
              className="stack"
            >
              <label className="field">
                Title
                <input
                  type="text"
                  value={title}
                  maxLength={200}
                  required
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <div>
                <button type="submit" className="primary" disabled={busy}>
                  Save title
                </button>
              </div>
            </form>
          ) : (
            <p className="muted">The Viewer role can't edit. Switch to Analyst to rename a case.</p>
          )}
        </section>
        <p>
          <Link to="/app/cases">Back to cases</Link>
        </p>
      </div>
    </>
  );
}
