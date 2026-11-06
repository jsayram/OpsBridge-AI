import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { ApiFailure, api, intentKeys } from "../api";
import { ErrorCard, SimBadge, Skeleton, StatusChip } from "../components/ui";
import { Link, useRouteFocus } from "../router";
import { can, useSession } from "../session";
import { Head, useLoad } from "./shared";

type EvidenceSource = {
  system: string;
  recordType: string;
  externalId: string;
  sourceTimestamp: string;
  externalVersion: string;
  fields: Record<string, string | null>;
};
export type Finding = {
  id: string;
  ref: string;
  kind: string;
  severity: string;
  status: string;
  version: number;
  customer: string | null;
  proposal: string | null;
  deferUntil: string | null;
  detectedAt: string;
  resolutionNote: string | null;
  resolvedBy: string | null;
  supersedes: string | null;
  superseded: boolean;
  readOnly: boolean;
  evidence: {
    sources: EvidenceSource[];
    differences: {
      field: string;
      values: Record<string, string | null>;
      normalizedEqual: boolean;
    }[];
    matchBasis: string;
    explanation: string;
    recommendedAction: string;
    rule: { ref: string; text: string | null } | null;
    needsTarget: boolean;
    suggestedCustomerId: string | null;
  };
};
type RunCounts = Record<string, number> & {
  rejected_sample?: never;
};
type Run = {
  id: string;
  kind: string;
  scenario: string;
  status: string;
  pages: number;
  counts: RunCounts;
  resumes: number;
  resumable: boolean;
  error: { class: string; code: string; message: string; state: string } | null;
  startedAt: string;
};
type Connection = {
  id: string;
  label: string;
  modeLabel: string;
  status: string;
  lastSuccessAt: string | null;
  freshness: string;
  lastErrorCode: string | null;
  scenarios: { name: string; label: string }[];
  lastRun: Run | null;
};
type Snapshot = {
  externalId: string;
  itemCode: string | null;
  quantity: string;
  unit: string;
  location: string | null;
  sourceVersion: number;
  observedAt: string;
};
type InventoryPage = {
  sourceLabel: string;
  items: {
    id: string;
    code: string;
    description: string;
    canonicalUnit: string;
    snapshots: Snapshot[];
  }[];
  unresolved: Snapshot[];
};
type Definitions = {
  terms: {
    term: string;
    crm: string;
    erp: string;
    canonical: string;
    steward: string;
    conflictRule: string;
  }[];
};

const KIND_LABEL: Record<string, string> = {
  definition_conflict: "Definition conflict",
  name_mismatch: "Name mismatch",
  account_mismatch: "Account ID mismatch",
  duplicate_client: "Possible duplicate",
  missing_client: "No canonical client",
  source_deleted: "Deleted at source",
  unknown_sku: "Unknown item",
  unit_mismatch: "Unit mismatch",
  invalid_unit: "Invalid unit",
  stale_snapshot: "Stale snapshot",
};
const STATUSES = ["Open", "Investigating", "Proposed", "Deferred", "Resolved", "Dismissed"];
const FRESHNESS: Record<string, string> = {
  never: "Never synced",
  fresh: "Fresh, within a day",
  aging: "Aging, within a week",
  stale: "Stale, over a week",
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "Not yet");
const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;

// A table that scrolls sideways and holds no link still has to be reachable from the keyboard.
const ScrollRegion = ({ label, children }: { label: string; children: ReactNode }) => (
  // biome-ignore lint/a11y/noNoninteractiveTabindex: the region scrolls, so it needs focus
  <section className="tscroll" tabIndex={0} aria-label={label}>
    {children}
  </section>
);

function useCapability(capability: string) {
  const { state } = useSession();
  return state.status === "ready" && can(state.me, capability);
}

function Severity({ value }: { value: string }) {
  const tone = value === "high" ? "bad" : value === "medium" ? "warn" : "neutral";
  return <span className={`chip ${tone}`}>{value}</span>;
}

export function Reconciliation() {
  useRouteFocus("Reconciliation");
  const [scope, setScope] = useState<"own" | "shared">("own");
  const [status, setStatus] = useState("");
  const query = `?limit=50${scope === "shared" ? "&scope=shared" : ""}${status ? `&status=${status}` : ""}`;
  const { data, failure, reload } = useLoad<{ items: Finding[] }>(`/reconciliation${query}`);
  const dictionary = useLoad<Definitions>("/reconciliation/definitions");
  return (
    <>
      <Head title="Reconciliation" route="/app/reconciliation" />
      <div className="stack">
        <p className="muted">
          Where two sources disagree, the evidence is here and a person decides. Nothing merges on a
          similar name, and nothing is written back to a source. <SimBadge />
        </p>
        <div className="row">
          <label className="field">
            Queue
            <select value={scope} onChange={(e) => setScope(e.target.value as "own" | "shared")}>
              <option value="own">Your workspace</option>
              <option value="shared">Shared samples (read-only)</option>
            </select>
          </label>
          <label className="field">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        {failure && <ErrorCard failure={failure} onRetry={reload} />}
        {!data && !failure && <Skeleton label="Loading findings" />}
        {data && (
          <section className="card">
            <h2>Findings</h2>
            {data.items.length === 0 ? (
              <p className="muted">Nothing here. Run a sync on the Integrations page.</p>
            ) : (
              <div className="tscroll">
                <table>
                  <caption>Newest first. Open a finding to see its source values.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Finding</th>
                      <th scope="col">Client</th>
                      <th scope="col">Severity</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((f) => (
                      <tr key={f.id}>
                        <th scope="row">
                          <Link to={`/app/reconciliation/${f.id}`}>{kindLabel(f.kind)}</Link>
                          <div className="small muted mono">{f.ref}</div>
                        </th>
                        <td>{f.customer ?? "Not mapped"}</td>
                        <td>
                          <Severity value={f.severity} />
                        </td>
                        <td>
                          {f.status}
                          {f.superseded ? " (superseded)" : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
        <details className="card">
          <summary>Business dictionary: what each source means by these words</summary>
          {dictionary.data && (
            <ScrollRegion label="Business dictionary table">
              <table>
                <caption>Stewards are fictional roles.</caption>
                <thead>
                  <tr>
                    <th scope="col">Term</th>
                    <th scope="col">CRM</th>
                    <th scope="col">ERP</th>
                    <th scope="col">Canonical</th>
                    <th scope="col">Conflict rule</th>
                  </tr>
                </thead>
                <tbody>
                  {dictionary.data.terms.map((t) => (
                    <tr key={t.term}>
                      <th scope="row">{t.term}</th>
                      <td>{t.crm}</td>
                      <td>{t.erp}</td>
                      <td>{t.canonical}</td>
                      <td>
                        {t.conflictRule} <span className="small muted">({t.steward})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          )}
        </details>
      </div>
    </>
  );
}

function FindingActions({ finding, onDone }: { finding: Finding; onDone: () => void }) {
  const canAdvance = useCapability("reconciliation:advance");
  const canResolve = useCapability("reconciliation:resolve");
  const customers = useLoad<{ items: { id: string; name: string }[] }>(
    finding.evidence.needsTarget ? "/customers" : null,
  );
  const [text, setText] = useState("");
  const [target, setTarget] = useState(finding.evidence.suggestedCustomerId ?? "");
  const [deferUntil, setDeferUntil] = useState("");
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef(intentKeys()).current;

  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await call();
      onDone();
    } catch (e) {
      if (e instanceof ApiFailure) setFailure(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  };
  const advance = (to: string) =>
    run(() =>
      api(`/reconciliation/${finding.id}/advance`, {
        method: "POST",
        body: { to, version: finding.version, ...(text ? { proposal: text } : {}) },
      }),
    );
  const resolve = (decision: string) => {
    const intent = `${finding.id}:${decision}:${finding.version}`;
    return run(async () => {
      try {
        await api(`/reconciliation/${finding.id}/resolve`, {
          method: "POST",
          idempotencyKey: keys.keyFor(intent),
          body: {
            decision,
            version: finding.version,
            ...(text ? { reason: text } : {}),
            ...(decision === "defer" && deferUntil
              ? { deferUntil: new Date(`${deferUntil}T12:00:00Z`).toISOString() }
              : {}),
            ...(decision === "approve" && finding.evidence.needsTarget && target
              ? { targetCustomerId: target }
              : {}),
          },
        });
        keys.settle();
      } catch (e) {
        keys.settle(e);
        throw e;
      }
    });
  };

  const { status } = finding;
  const open = ["Open", "Investigating", "Proposed"].includes(status);
  if (finding.readOnly) {
    return <p className="muted">Shared sample finding, read-only for every visitor.</p>;
  }
  if (status === "Resolved" || status === "Dismissed") {
    return (
      <p>
        {status} by {finding.resolvedBy}. {finding.resolutionNote}
      </p>
    );
  }
  if (!canAdvance && !canResolve) {
    return <p className="muted">The Viewer role can't act here. Switch to Analyst or Manager.</p>;
  }
  return (
    <div className="stack">
      {finding.superseded && (
        <p className="err">Newer source evidence replaced this finding, so it can't be approved.</p>
      )}
      {finding.proposal && (
        <p>
          <strong>Proposed:</strong> {finding.proposal}
        </p>
      )}
      <label className="field">
        {status === "Investigating" ? "What you propose" : "Note or reason"}
        <textarea value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
      </label>
      {finding.evidence.needsTarget && status === "Proposed" && canResolve && (
        <label className="field">
          Link to customer (your decision, not a match)
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose a customer</option>
            {customers.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="actions">
        {status === "Open" && canAdvance && (
          <button type="button" disabled={busy} onClick={() => void advance("Investigating")}>
            Start investigating
          </button>
        )}
        {status === "Investigating" && canAdvance && (
          <button type="button" disabled={busy} onClick={() => void advance("Proposed")}>
            Propose resolution
          </button>
        )}
        {status === "Deferred" && canAdvance && (
          <button type="button" disabled={busy} onClick={() => void advance("Open")}>
            Back to the queue
          </button>
        )}
        {status === "Proposed" && canResolve && (
          <button
            type="button"
            className="primary"
            disabled={busy || finding.superseded}
            onClick={() => void resolve("approve")}
          >
            Approve resolution
          </button>
        )}
        {open && canResolve && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void resolve("reject")}
          >
            Reject
          </button>
        )}
      </div>
      {open && canResolve && (
        <div className="row">
          <label className="field">
            Defer until
            <input type="date" value={deferUntil} onChange={(e) => setDeferUntil(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={busy || !deferUntil}
            onClick={() => void resolve("defer")}
          >
            Defer
          </button>
        </div>
      )}
      {open && !canResolve && <p className="small muted">A Manager makes the final decision.</p>}
      {failure && <ErrorCard failure={failure} onRetry={onDone} retryLabel="Reload" />}
    </div>
  );
}

export function FindingDetail({ id }: { id: string }) {
  const { data, failure, reload } = useLoad<Finding>(`/reconciliation/${encodeURIComponent(id)}`);
  useRouteFocus(data ? kindLabel(data.kind) : "Finding");
  return (
    <>
      <Head title={data ? kindLabel(data.kind) : "Finding"} route={`/app/reconciliation/${id}`} />
      {failure && <ErrorCard failure={failure} onRetry={reload} />}
      {!data && !failure && <Skeleton label="Loading finding" />}
      {data && (
        <div className="stack">
          <section className="card">
            <div className="row between">
              <h2>{data.customer ?? "Not mapped to a client"}</h2>
              <div className="row">
                <Severity value={data.severity} />
                <StatusChip status={data.status} />
                <SimBadge />
              </div>
            </div>
            <p>{data.evidence.explanation}</p>
            {data.evidence.rule?.text && (
              <p>
                <strong>Rule {data.evidence.rule.ref}:</strong> {data.evidence.rule.text}
              </p>
            )}
            <p className="small muted">
              Matched by {data.evidence.matchBasis.replace("_", " ")}.{" "}
              {data.supersedes && (
                <Link to={`/app/reconciliation/${data.supersedes}`}>
                  See the finding this replaces.
                </Link>
              )}
            </p>
          </section>
          <section className="card">
            <h2>Source evidence</h2>
            <div className="stack">
              {data.evidence.sources.map((s) => (
                <div key={`${s.system}-${s.externalId}`}>
                  <h3>
                    {s.system}{" "}
                    <span className="small muted mono">
                      {s.recordType} {s.externalId}
                    </span>
                  </h3>
                  <p className="small muted">Source timestamp {when(s.sourceTimestamp)}</p>
                  <dl className="facts">
                    {Object.entries(s.fields)
                      .filter(([, v]) => v !== null)
                      .map(([k, v]) => (
                        <div key={k}>
                          <dt className="small muted">{k}</dt>
                          <dd>{v}</dd>
                        </div>
                      ))}
                  </dl>
                </div>
              ))}
            </div>
          </section>
          {data.evidence.differences.length > 0 && (
            <section className="card">
              <h2>What differs</h2>
              <ul className="list">
                {data.evidence.differences.map((d) => (
                  <li key={d.field}>
                    <strong>{d.field}</strong>
                    <ul>
                      {Object.entries(d.values).map(([k, v]) => (
                        <li key={k}>
                          {k}: {v ?? "None"}
                        </li>
                      ))}
                    </ul>
                    {d.normalizedEqual && (
                      <span className="small muted">The same after normalizing.</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="card">
            <h2>Decision</h2>
            <p className="muted">{data.evidence.recommendedAction}</p>
            <FindingActions key={data.version} finding={data} onDone={reload} />
          </section>
          <p>
            <Link to="/app/reconciliation">Back to reconciliation</Link>
          </p>
        </div>
      )}
    </>
  );
}

function ConnectionCard({ connection, onDone }: { connection: Connection; onDone: () => void }) {
  const canSync = useCapability("integrations:sync_simulated");
  const canRecover = useCapability("integrations:recover");
  const [scenario, setScenario] = useState("baseline");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const keys = useRef(intentKeys()).current;
  const run = connection.lastRun;

  const act = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await call();
      onDone();
    } catch (e) {
      if (e instanceof ApiFailure) setFailure(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  };
  const sync = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      try {
        await api(`/integrations/${connection.id}/sync`, {
          method: "POST",
          idempotencyKey: keys.keyFor(`${connection.id}:${scenario}:${run?.id ?? "first"}`),
          body: { scenario },
        });
        keys.settle();
      } catch (err) {
        keys.settle(err);
        throw err;
      }
    });
  };
  const resume = () =>
    act(() =>
      api(`/integrations/${connection.id}/runs/${run?.id}/resume`, { method: "POST", body: {} }),
    );

  return (
    <section className="card" aria-label={connection.label}>
      <div className="row between">
        <h2>{connection.label}</h2>
        <div className="row">
          <span className={`chip ${connection.status === "Degraded" ? "bad" : "info"}`}>
            {connection.status}
          </span>
          <SimBadge>{connection.modeLabel}</SimBadge>
        </div>
      </div>
      <dl className="facts">
        <div>
          <dt className="small muted">Freshness</dt>
          <dd>{FRESHNESS[connection.freshness]}</dd>
        </div>
        <div>
          <dt className="small muted">Last success</dt>
          <dd>{when(connection.lastSuccessAt)}</dd>
        </div>
      </dl>
      {run && (
        <p className="small" role="status">
          Last run: {run.status.replace("_", " ")}, {run.kind}, {run.pages} pages. {run.counts.seen}{" "}
          seen, {run.counts.created} new, {run.counts.updated} changed, {run.counts.unchanged}{" "}
          unchanged, {run.counts.stale_skipped} stale, {run.counts.duplicate_skipped} duplicate,{" "}
          {run.counts.unknown_fields_dropped} unknown fields dropped, {run.counts.rejected}{" "}
          rejected, {run.counts.findings_opened} findings opened.
        </p>
      )}
      {run?.error && (
        <div role="alert">
          <p className="err">
            {run.error.state === "dead_letter" ? "Needs an operator. " : "Failed safely. "}
            {run.error.message}
          </p>
          <p className="small muted">
            Code <span className="mono">{run.error.code}</span>
          </p>
        </div>
      )}
      <div className="actions">
        {canSync && connection.scenarios.length > 0 && (
          <form onSubmit={sync} className="row">
            <label className="field">
              Scenario
              <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
                {connection.scenarios.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="primary" disabled={busy}>
              Run simulated sync
            </button>
          </form>
        )}
        {run?.resumable && canRecover && (
          <button type="button" disabled={busy} onClick={() => void resume()}>
            Resume from saved cursor
          </button>
        )}
        {run?.resumable && !canRecover && (
          <p className="small muted">A Manager can resume this run.</p>
        )}
      </div>
      {!canSync && (
        <p className="small muted">The Viewer role can read this. Switch to Analyst to sync.</p>
      )}
      {failure && <ErrorCard failure={failure} />}
    </section>
  );
}

export function Integrations() {
  useRouteFocus("Integrations");
  const { data, failure, reload } = useLoad<{ items: Connection[] }>("/integrations");
  return (
    <>
      <Head title="Integrations" route="/app/integrations" />
      <div className="stack">
        <p className="muted">
          Each source here is a labeled simulator. Scenarios replay the failures real connectors
          meet, from a fixed list. Nothing here reaches a real system.
        </p>
        {failure && <ErrorCard failure={failure} onRetry={reload} />}
        {!data && !failure && <Skeleton label="Loading integrations" />}
        {data?.items.map((c) => (
          <ConnectionCard key={c.id} connection={c} onDone={reload} />
        ))}
        {data && (
          <section className="card">
            <h2>Salesforce test org</h2>
            <p className="muted">
              Owner only and not part of this demo. Pending Owner Credentials: no real org has been
              connected.
            </p>
          </section>
        )}
      </div>
    </>
  );
}

const SnapshotRows = ({ rows }: { rows: Snapshot[] }) =>
  rows.map((s) => (
    <tr key={s.externalId}>
      <th scope="row" className="mono">
        {s.externalId}
      </th>
      <td>{s.itemCode}</td>
      <td className="r">
        {s.quantity} {s.unit}
      </td>
      <td>{s.location ?? "Unknown"}</td>
      <td className="r">{s.sourceVersion}</td>
      <td>{when(s.observedAt)}</td>
    </tr>
  ));

const SnapshotHead = () => (
  <thead>
    <tr>
      <th scope="col">Source record</th>
      <th scope="col">Item code</th>
      <th scope="col" className="r">
        Quantity
      </th>
      <th scope="col">Location</th>
      <th scope="col" className="r">
        Version
      </th>
      <th scope="col">Source timestamp</th>
    </tr>
  </thead>
);

export function Inventory() {
  useRouteFocus("Inventory");
  const { data, failure, reload } = useLoad<InventoryPage>("/inventory");
  return (
    <>
      <Head title="Inventory" route="/app/inventory" />
      <div className="stack">
        <p className="muted">
          Read-only facts from a simulated source. Nothing on this page can order, reserve or change
          stock, and no unit is ever converted. <SimBadge />
        </p>
        {failure && <ErrorCard failure={failure} onRetry={reload} />}
        {!data && !failure && <Skeleton label="Loading inventory" />}
        {data?.items.map((item) => (
          <section className="card" key={item.id}>
            <h2>
              {item.code} <span className="small muted">{item.description}</span>
            </h2>
            <p className="small muted">Canonical unit: {item.canonicalUnit}</p>
            {item.snapshots.length === 0 ? (
              <p className="muted">No source snapshot yet.</p>
            ) : (
              <ScrollRegion label={`${item.code} snapshots`}>
                <table>
                  <caption>Newest source version of each record.</caption>
                  <SnapshotHead />
                  <tbody>
                    <SnapshotRows rows={item.snapshots} />
                  </tbody>
                </table>
              </ScrollRegion>
            )}
          </section>
        ))}
        {data && data.unresolved.length > 0 && (
          <section className="card">
            <h2>Not matched to an item</h2>
            <p className="muted">Kept as source facts. No item was invented for them.</p>
            <ScrollRegion label="Unmatched snapshots">
              <table>
                <caption>Each one has a finding in Reconciliation.</caption>
                <SnapshotHead />
                <tbody>
                  <SnapshotRows rows={data.unresolved} />
                </tbody>
              </table>
            </ScrollRegion>
          </section>
        )}
      </div>
    </>
  );
}

type SalesforceStatus = {
  label: string;
  configured: boolean;
  testDouble: boolean;
  claim: string;
  connection: { id: string; status: string; lastSuccessAt: string | null } | null;
};

export function SalesforceAdmin() {
  const { data, failure, reload } = useLoad<SalesforceStatus>("/admin/integrations/salesforce", {
    guestPath: false,
  });
  const [actionFailure, setActionFailure] = useState<ApiFailure | null>(null);
  const attempt = async (call: () => Promise<void>) => {
    setActionFailure(null);
    try {
      await call();
    } catch (e) {
      if (e instanceof ApiFailure) setActionFailure(e);
      else throw e;
    }
  };
  const start = () =>
    attempt(async () => {
      const { authorizeUrl } = await api<{ authorizeUrl: string }>(
        "/admin/integrations/salesforce/authorize",
        { method: "POST", body: {} },
      );
      window.location.assign(authorizeUrl);
    });
  const stop = (id: string) =>
    attempt(async () => {
      await api(`/admin/integrations/${id}/disconnect`, { method: "POST", body: {} });
      reload();
    });
  if (failure) return <ErrorCard failure={failure} onRetry={reload} />;
  if (!data) return <Skeleton label="Loading Salesforce status" />;
  const live = data.connection && data.connection.status !== "Disconnected";
  return (
    <section className="card state-panel">
      <h2>{data.label}</h2>
      <p>
        {data.claim}
        {data.testDouble ? ", running against a labeled test double" : ""}.
        {data.connection ? ` Status: ${data.connection.status}.` : " Not connected."}
      </p>
      {data.configured ? (
        live ? (
          <button type="button" onClick={() => void stop(data.connection?.id as string)}>
            Disconnect and revoke
          </button>
        ) : (
          <button type="button" onClick={() => void start()}>
            Connect read-only test org
          </button>
        )
      ) : (
        <p className="muted">Not configured. See the connector runbook.</p>
      )}
      {actionFailure && <ErrorCard failure={actionFailure} />}
    </section>
  );
}
