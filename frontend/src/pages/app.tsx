import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiFailure, api, type CaseRow, type Summary } from "../api";
import { ErrorCard, SimBadge, Skeleton, StatusChip } from "../components/ui";
import { Link, useRouteFocus } from "../router";
import { can, useSession } from "../session";

function useLoad<T>(path: string | null) {
  const { sessionEnded } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce forces a reload
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setData(null);
    setFailure(null);
    api<T>(path, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (e instanceof ApiFailure && e.status === 401) sessionEnded();
        else if (e instanceof ApiFailure) setFailure(e);
      });
    return () => controller.abort();
  }, [path, nonce, sessionEnded]);

  return { data, failure, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

const STATUSES = ["Draft", "Intake", "Needs Review", "Ready", "Approved", "Closed"];
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "No date";

const Head = ({ title, route }: { title: string; route: string }) => (
  <div className="page-head">
    <h1>{title}</h1>
    <span className="route">{route}</span>
  </div>
);

export function Overview() {
  useRouteFocus("Overview");
  const { state } = useSession();
  const { data, failure, reload } = useLoad<Summary>("/workspace/summary");
  const resetKey = state.status === "ready" && state.me.kind === "guest" ? state.me.expiresAt : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: a reset changes the expiry
  useEffect(() => reload(), [resetKey, reload]);
  return (
    <>
      <Head title="Overview" route="/app/overview" />
      {failure && <ErrorCard failure={failure} onRetry={reload} />}
      {!data && !failure && <Skeleton label="Loading overview" />}
      {data && (
        <div className="stack">
          <div className="grid cols-4">
            <section className="card kpi">
              <div className="label">Your cases</div>
              <div className="value">{sum(data.workspaceCases)}</div>
              <div className="note">Editable in this workspace</div>
            </section>
            <section className="card kpi">
              <div className="label">Shared sample cases</div>
              <div className="value">{sum(data.templateCases)}</div>
              <div className="note">Read-only</div>
            </section>
          </div>
          <section className="card">
            <header>
              <h2>Cases by status</h2>
              <SimBadge>Synthetic</SimBadge>
            </header>
            <div className="tscroll">
              <table>
                <caption>Counts come from the database for this workspace.</caption>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col" className="r">
                      Yours
                    </th>
                    <th scope="col" className="r">
                      Shared
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {STATUSES.map((s) => (
                    <tr key={s}>
                      <th scope="row">
                        <StatusChip status={s} />
                      </th>
                      <td className="r">{data.workspaceCases[s] ?? 0}</td>
                      <td className="r">{data.templateCases[s] ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <h2>Next</h2>
            <p className="muted">
              Start with <Link to="/app/cases">Cases</Link>. Other areas say which phase adds them.
            </p>
          </section>
        </div>
      )}
    </>
  );
}

export function Cases() {
  useRouteFocus("Cases");
  const { sessionEnded, state } = useSession();
  const [status, setStatus] = useState("");
  const resetKey = state.status === "ready" && state.me.kind === "guest" ? state.me.expiresAt : "";
  const [items, setItems] = useState<CaseRow[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [nonce, setNonce] = useState(0);

  const fetchPage = useCallback(
    async (after: string | undefined, signal?: AbortSignal) => {
      const q = new URLSearchParams({ limit: "25" });
      if (status) q.set("status", status);
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
    [status, sessionEnded],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce and reset force a reload
  useEffect(() => {
    const controller = new AbortController();
    setItems(null);
    setFailure(null);
    void fetchPage(undefined, controller.signal);
    return () => controller.abort();
  }, [fetchPage, nonce, resetKey]);

  return (
    <>
      <Head title="Cases" route="/app/cases" />
      <div className="filters">
        <label className="field">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="sr-only" role="status">
        {items ? `${items.length} cases shown.` : ""}
      </p>
      {failure && <ErrorCard failure={failure} onRetry={() => setNonce((n) => n + 1)} />}
      {!items && !failure && <Skeleton label="Loading cases" />}
      {items?.length === 0 && (
        <section className="card state-panel">
          <h2>No cases match</h2>
          <button type="button" onClick={() => setStatus("")}>
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
                  <th scope="col">Due</th>
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
                    <td>{day(c.dueAt)}</td>
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

export function CaseDetail({ id }: { id: string }) {
  useRouteFocus("Case");
  const { state, sessionEnded } = useSession();
  const { data, failure, reload } = useLoad<CaseRow>(`/cases/${encodeURIComponent(id)}`);
  const [title, setTitle] = useState("");
  const [saveFailure, setSaveFailure] = useState<ApiFailure | null>(null);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    if (data) setTitle(data.title);
  }, [data]);

  const canEdit = state.status === "ready" && can(state.me, "cases:edit");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!data) return;
    setSaveFailure(null);
    setSaved("");
    try {
      await api(`/cases/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { title, version: data.version },
      });
      setSaved("Saved.");
      reload();
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) sessionEnded();
      else if (err instanceof ApiFailure) setSaveFailure(err);
    }
  };

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
      <section className="card">
        <dl className="stack">
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
            <dt className="small muted">Due</dt>
            <dd>{day(data.dueAt)}</dd>
          </div>
        </dl>
      </section>
      <section className="card">
        <h2>Rename</h2>
        {data.readOnly ? (
          <p className="muted">Shared sample case, read-only for every visitor.</p>
        ) : canEdit ? (
          <form onSubmit={(e) => void save(e)} className="stack">
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
              <button type="submit" className="primary">
                Save title
              </button>
            </div>
            <p role="status" className="small muted">
              {saved}
            </p>
            {saveFailure && (
              <ErrorCard
                failure={saveFailure}
                {...(saveFailure.code === "stale_version" ? { onRetry: reload } : {})}
              />
            )}
          </form>
        ) : (
          <p className="muted">The Viewer role can't edit. Switch to Analyst to rename a case.</p>
        )}
      </section>
      <p>
        <Link to="/app/cases">Back to cases</Link>
      </p>
    </>
  );
}

const LATER: Record<string, { title: string; phase: string; note: string }> = {
  reconciliation: {
    title: "Reconciliation",
    phase: "P3",
    note: "Compares simulated CRM and ERP records and shows the evidence for each mismatch.",
  },
  automations: {
    title: "Automations",
    phase: "P4",
    note: "Rules, the durable outbox and honest delivery labels.",
  },
  analytics: {
    title: "Analytics",
    phase: "P6",
    note: "Trends, source freshness and ROI with clear provenance.",
  },
  integrations: {
    title: "Integrations",
    phase: "P3",
    note: "Connector status. Nothing is connected in this build.",
  },
};

export function Later({ area }: { area: string }) {
  const page = LATER[area] ?? { title: "Not built", phase: "a later phase", note: "" };
  useRouteFocus(page.title);
  return (
    <>
      <Head title={page.title} route={`/app/${area}`} />
      <section className="card state-panel">
        <h2>Not built yet</h2>
        <p className="muted">{page.note}</p>
        <p className="small muted">Planned for phase {page.phase}.</p>
      </section>
    </>
  );
}

type AdminStatus = { ownerIdentity: string; identityMode: string; simulated: boolean };

export function Admin() {
  useRouteFocus("Administration");
  const { data, failure, reload } = useLoad<AdminStatus>("/admin/status");
  const [signedOut, setSignedOut] = useState(false);
  const logout = async () => {
    await api("/admin/logout", { method: "POST" });
    setSignedOut(true);
  };
  return (
    <>
      <Head title="Administration" route="/admin" />
      {failure && <ErrorCard failure={failure} onRetry={reload} />}
      {!data && !failure && <Skeleton label="Loading administration" />}
      {data && (
        <section className="card state-panel">
          <h2>Owner identity</h2>
          <p>{data.ownerIdentity}</p>
          {data.simulated && (
            <p>
              <SimBadge>Local test double</SimBadge> No real identity provider is involved.
            </p>
          )}
          {signedOut ? (
            <p role="status">Signed out.</p>
          ) : (
            <button type="button" onClick={() => void logout()}>
              Sign out
            </button>
          )}
        </section>
      )}
    </>
  );
}
