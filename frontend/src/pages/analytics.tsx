import { useId, useMemo, useState } from "react";
import { ApiFailure, api } from "../api";
import { ErrorCard, SimBadge, Skeleton, StatusChip } from "../components/ui";
import {
  ASSUMPTIONS_VERSION,
  calculate,
  INPUTS,
  type InputKey,
  ROI_LABEL,
  type RoiInputs,
  SCENARIOS,
  sensitivity,
  usd,
  validate,
} from "../lib/roi";
import { Link, useRouteFocus } from "../router";
import { useSession } from "../session";
import { Head, STATUSES, useLoad } from "./shared";

type Provenance = "SYNTHETIC" | "MEASURED_DEMO" | "ESTIMATED" | "UNKNOWN";
type Metric = {
  key: string;
  label: string;
  unit: string;
  provenance: Provenance;
  value: number | null;
};
type Source = {
  provider: string;
  shared: boolean;
  sourceLabel: string;
  live: boolean;
  status: string;
  lastSuccessAt: string | null;
  lastErrorCode?: string | null;
  runsSucceeded?: number;
  runsFailed?: number;
  retries?: number;
  recordsProcessed?: number;
};
type Overview = {
  definitionVersion: string;
  computedAt: string;
  scope: "workspace" | "workspace_and_shared_samples";
  provenanceText: Record<Provenance, string>;
  glossary: Record<string, { label: string; formula: string }>;
  pulse: Metric[];
  funnel: {
    stages: { status: string; count: number; reached: number }[];
    completionRate: Metric;
    denominator: number;
  };
  integration: { sources: Source[]; lastSyncAge: Metric; lastSuccessAt: string | null };
  quality: {
    metrics: Metric[];
    byKind: { kind: string; unresolved: number; resolved: number; dismissed: number }[];
    mismatchedFields: { field: string; count: number }[];
  };
  ai: {
    metrics: Metric[];
    byStatus: Record<string, number>;
    byMode: Record<string, number>;
    decidedSample: number;
    liveState: string;
    evaluation: {
      disclosure: string;
      model: string;
      date: string;
      documents: number;
      standardAccuracy: number;
      messyWithTextAccuracy: number;
      schemaValid: number;
      unauthorizedWrites: number;
      adversarialOverrides: number;
      report: string;
    };
  };
  automation: {
    byLabel: Record<string, number>;
    acceptedNote: string;
    metrics: Metric[];
    assumedStepsPerNotice: number;
  };
};

const PROVENANCE_NAME: Record<Provenance, string> = {
  SYNTHETIC: "Synthetic",
  MEASURED_DEMO: "Measured in demo",
  ESTIMATED: "Estimated",
  UNKNOWN: "Unknown",
};

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "Never";

export function formatMetric(m: Metric): string {
  if (m.value === null) return m.provenance === "UNKNOWN" ? "Not available" : "None yet";
  switch (m.unit) {
    case "ratio":
      return pct(m.value);
    case "days":
      return `${m.value} ${m.value === 1 ? "day" : "days"}`;
    case "hours":
      return `${m.value} h`;
    case "minutes":
      return `${m.value} min`;
    case "usd":
      return `$${m.value.toFixed(2)}`;
    default:
      return m.value.toLocaleString("en-US");
  }
}

// Built from the rows, so the caption can't contradict them.
function sourceSummary(sources: Source[]) {
  const sim = sources.filter((s) => s.sourceLabel === "Simulated").length;
  const test = sources.filter((s) => s.sourceLabel === "Connected test").length;
  const parts = [`${sim} simulated`];
  if (test) parts.push(`${test} connected test (a sandbox org, not production data)`);
  return `${parts.join(", ")}. No production system is connected.`;
}

export const ProvenanceBadge = ({ p }: { p: Provenance }) => (
  <span className={`badge prov ${p.toLowerCase()}`}>{PROVENANCE_NAME[p]}</span>
);

// A key metric is a heading, so a screen reader user can jump between them, followed by its value,
// how it was produced and its formula.
function Kpi({ m, glossary }: { m: Metric; glossary: Overview["glossary"] }) {
  return (
    <div className="card kpi">
      <h3 className="label">{m.label}</h3>
      <p className="value" data-metric={m.key}>
        {formatMetric(m)}
      </p>
      <p className="note">
        <ProvenanceBadge p={m.provenance} />
      </p>
      <p className="small muted">{glossary[m.key]?.formula}</p>
    </div>
  );
}

// A table wider than a phone scrolls sideways; the region takes focus so a keyboard can scroll it.
const Scroll = ({ label, children }: { label: string; children: React.ReactNode }) => (
  // biome-ignore lint/a11y/noNoninteractiveTabindex: the region scrolls, so it needs focus
  <section className="tscroll" tabIndex={0} aria-label={label}>
    {children}
  </section>
);

// Horizontal bars. The chart is a picture of the table next to it, so it is hidden from screen
// readers and the table carries the numbers.
function Bars({ rows, label }: { rows: { name: string; value: number }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const h = 22;
  return (
    <svg
      className="bars"
      viewBox={`0 0 320 ${rows.length * h}`}
      width="100%"
      height={rows.length * h}
      aria-hidden="true"
      focusable="false"
      data-chart={label}
    >
      {rows.map((r, i) => (
        <g key={r.name} transform={`translate(0 ${i * h})`}>
          <text x="0" y="15" className="bar-label">
            {r.name}
          </text>
          <rect x="120" y="4" height="14" width={(r.value / max) * 160} className="bar" rx="2" />
          <text x={126 + (r.value / max) * 160} y="15" className="bar-value">
            {r.value}
          </text>
        </g>
      ))}
    </svg>
  );
}

function Section({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section className="card" aria-labelledby={id}>
      <header className="card-head">
        <h2 id={id}>{title}</h2>
        {badge}
      </header>
      {children}
    </section>
  );
}

function Trend({ metric }: { metric: string }) {
  const { data, failure } = useLoad<{
    label: string;
    shared: { points: { period: string; value: number }[] };
    own: { points: { period: string; value: number }[] };
  }>(`/analytics/trends?metric=${metric}`);
  if (failure) return <ErrorCard failure={failure} />;
  if (!data) return <Skeleton label="Loading trend" />;
  const pts = data.shared.points.length ? data.shared.points : data.own.points;
  const max = Math.max(1, ...pts.map((p) => p.value));
  const path = pts
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${(i / Math.max(1, pts.length - 1)) * 300} ${60 - (p.value / max) * 56}`,
    )
    .join(" ");
  const first = pts[0];
  const last = pts.at(-1);
  return (
    <div>
      {pts.length > 0 && first && last ? (
        <>
          <p className="small">
            {data.label}: {first.value} on {first.period}, {last.value} on {last.period}.{" "}
            <SimBadge>Synthetic history</SimBadge>
          </p>
          <svg viewBox="0 0 300 62" width="100%" height="62" aria-hidden="true" focusable="false">
            <path d={path} className="trend-line" fill="none" />
          </svg>
          <details>
            <summary>Show the {pts.length} daily values as a table</summary>
            <Scroll label={`${data.label} by day`}>
              <table>
                <caption>{data.label} by day (UTC)</caption>
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col" className="r">
                      Value
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pts.map((p) => (
                    <tr key={p.period}>
                      <th scope="row">{p.period}</th>
                      <td className="r">{p.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          </details>
        </>
      ) : (
        <p className="muted">No history yet.</p>
      )}
      {data.own.points.length > 0 && data.shared.points.length > 0 && (
        <p className="small muted">
          Your recorded days: {data.own.points.map((p) => `${p.period} = ${p.value}`).join(", ")}
        </p>
      )}
    </div>
  );
}

export function Analytics() {
  useRouteFocus("Analytics");
  const { state } = useSession();
  const caps = state.status === "ready" ? state.me.capabilities : [];
  const { data, failure, reload } = useLoad<Overview>("/analytics/overview");
  const [recorded, setRecorded] = useState<string | null>(null);
  const [recordFailure, setRecordFailure] = useState<ApiFailure | null>(null);
  const record = async () => {
    setRecordFailure(null);
    try {
      const out = await api<{ period: string }>("/analytics/snapshots", { method: "POST" });
      setRecorded(out.period);
      reload();
    } catch (e) {
      if (e instanceof ApiFailure) setRecordFailure(e);
      else throw e;
    }
  };
  return (
    <>
      <Head title="Analytics" route="/app/analytics" />
      {failure && <ErrorCard failure={failure} onRetry={reload} />}
      {!data && !failure && <Skeleton label="Loading analytics" />}
      {data && (
        <div className="stack">
          <p className="callout">
            <span className="t">Every number is computed now from this workspace's records.</span>
            {data.scope === "workspace_and_shared_samples"
              ? "It counts your cases plus the read-only shared samples, the same rows the case list shows. "
              : "It counts the owner workspace only. "}
            Counts cover every date; the report page filters by a date range of up to 366 days, so
            its default total can be lower. Calculated {when(data.computedAt)}, definitions{" "}
            {data.definitionVersion}. <Link to="/app/reports">Filter and export the rows</Link> or{" "}
            <Link to="/app/roi">model the ROI</Link>.
          </p>
          <Section title="Operations pulse">
            <div className="grid cols-4">
              {data.pulse.map((m) => (
                <Kpi key={m.key} m={m} glossary={data.glossary} />
              ))}
            </div>
          </Section>

          <Section title="Workflow funnel" badge={<ProvenanceBadge p="SYNTHETIC" />}>
            <div className="split-even grid">
              <Bars
                label="funnel"
                rows={data.funnel.stages.map((s) => ({ name: s.status, value: s.count }))}
              />
              <Scroll label="Cases by stage">
                <table>
                  <caption>
                    Cases by stage. Completion rate {formatMetric(data.funnel.completionRate)} of{" "}
                    {data.funnel.denominator} non-draft cases.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Stage</th>
                      <th scope="col" className="r">
                        In stage
                      </th>
                      <th scope="col" className="r">
                        Reached
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.funnel.stages.map((s) => (
                      <tr key={s.status}>
                        <th scope="row">
                          <StatusChip status={s.status} />
                        </th>
                        <td className="r">{s.count}</td>
                        <td className="r">{s.reached}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            </div>
            <h3>Open cases: 90 days of shared synthetic history, plus your recorded days</h3>
            <Trend key={recorded ?? "none"} metric="open_cases" />
          </Section>

          <Section title="Integration health">
            {data.integration.sources.length === 0 ? (
              <p className="muted">No source connections in this scope.</p>
            ) : (
              <Scroll label="Source connections">
                <table>
                  <caption>
                    {sourceSummary(data.integration.sources)} Last successful sync:{" "}
                    {when(data.integration.lastSuccessAt)}.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Source</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Status</th>
                      <th scope="col">Last success</th>
                      <th scope="col" className="r">
                        Runs ok
                      </th>
                      <th scope="col" className="r">
                        Failed
                      </th>
                      <th scope="col" className="r">
                        Retries
                      </th>
                      <th scope="col" className="r">
                        Records
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.integration.sources.map((s) => (
                      <tr key={`${s.shared}-${s.provider}`}>
                        <th scope="row">
                          {s.provider}
                          {s.shared ? " (shared sample)" : ""}
                        </th>
                        <td>
                          <SimBadge>{s.sourceLabel}</SimBadge>
                        </td>
                        <td>{s.status}</td>
                        <td>{when(s.lastSuccessAt)}</td>
                        <td className="r">{s.runsSucceeded}</td>
                        <td className="r">{s.runsFailed}</td>
                        <td className="r">{s.retries}</td>
                        <td className="r">{s.recordsProcessed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </Section>

          <Section title="Data quality" badge={<ProvenanceBadge p="SYNTHETIC" />}>
            <div className="grid cols-4">
              {data.quality.metrics.map((m) => (
                <Kpi key={m.key} m={m} glossary={data.glossary} />
              ))}
            </div>
            <Scroll label="Findings by kind">
              <table>
                <caption>Reconciliation findings by kind</caption>
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col" className="r">
                      Unresolved
                    </th>
                    <th scope="col" className="r">
                      Resolved
                    </th>
                    <th scope="col" className="r">
                      Dismissed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.quality.byKind.map((k) => (
                    <tr key={k.kind}>
                      <th scope="row">{k.kind}</th>
                      <td className="r">{k.unresolved}</td>
                      <td className="r">{k.resolved}</td>
                      <td className="r">{k.dismissed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
            <p className="small">
              Fields most often mismatched:{" "}
              {data.quality.mismatchedFields.length
                ? data.quality.mismatchedFields.map((f) => `${f.field} (${f.count})`).join(", ")
                : "none recorded yet."}
            </p>
          </Section>

          <Section title="AI assistance" badge={<SimBadge>Fixture mode</SimBadge>}>
            <div className="grid cols-4">
              {data.ai.metrics.map((m) => (
                <Kpi key={m.key} m={m} glossary={data.glossary} />
              ))}
            </div>
            <Scroll label="Reviews by status">
              <table>
                <caption>Reviews by status</caption>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col" className="r">
                      Reviews
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.ai.byStatus).map(([s, n]) => (
                    <tr key={s}>
                      <th scope="row">{s}</th>
                      <td className="r">{n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
            <div className="callout warn">
              <span className="t">Fixture evaluation, not model accuracy</span>
              <p>{data.ai.evaluation.disclosure}</p>
              <p className="small">
                {data.ai.evaluation.documents} documents, run {when(data.ai.evaluation.date)} with{" "}
                <span className="mono">{data.ai.evaluation.model}</span>: standard set{" "}
                {pct(data.ai.evaluation.standardAccuracy)}, messy documents with text{" "}
                {pct(data.ai.evaluation.messyWithTextAccuracy)}, schema-valid{" "}
                {pct(data.ai.evaluation.schemaValid)}, {data.ai.evaluation.unauthorizedWrites}{" "}
                unauthorized writes, {data.ai.evaluation.adversarialOverrides} adversarial
                overrides. Report: <span className="mono">{data.ai.evaluation.report}</span>.
              </p>
              <p className="small">
                Live AI:{" "}
                {data.ai.liveState === "pending_owner_credentials"
                  ? "Pending Owner Credentials. No provider is configured, so live cost is unknown, not zero."
                  : "configured by the owner."}
              </p>
            </div>
          </Section>

          <Section title="Automation">
            <div className="split-even grid">
              <Bars
                label="automation"
                rows={Object.entries(data.automation.byLabel).map(([name, value]) => ({
                  name,
                  value,
                }))}
              />
              <Scroll label="Events by delivery label">
                <table>
                  <caption>Notification events by delivery label</caption>
                  <thead>
                    <tr>
                      <th scope="col">Label</th>
                      <th scope="col" className="r">
                        Events
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.automation.byLabel).map(([l, n]) => (
                      <tr key={l}>
                        <th scope="row">{l}</th>
                        <td className="r">{n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            </div>
            <p className="small muted">{data.automation.acceptedNote}</p>
            <div className="grid cols-4">
              {data.automation.metrics.map((m) => (
                <Kpi key={m.key} m={m} glossary={data.glossary} />
              ))}
            </div>
          </Section>

          <Section title="What the labels mean">
            <dl className="facts">
              {(Object.keys(data.provenanceText) as Provenance[]).map((p) => (
                <div key={p}>
                  <dt>
                    <ProvenanceBadge p={p} />
                  </dt>
                  <dd>{data.provenanceText[p]}</dd>
                </div>
              ))}
            </dl>
            {caps.includes("analytics:snapshot") && (
              <p>
                <button type="button" onClick={() => void record()}>
                  Record today's snapshot
                </button>{" "}
                <span role="status">
                  {recorded ? `Recorded your values for ${recorded} (UTC).` : ""}
                </span>
              </p>
            )}
            {recordFailure && <ErrorCard failure={recordFailure} />}
          </Section>
        </div>
      )}
    </>
  );
}

// --- P6.3 Reports ----------------------------------------------------------------------------

type ReportResponse = {
  filters: {
    from: string;
    to: string;
    status: string | null;
    assignee: string | null;
    source: string | null;
    sort: string;
  };
  page: number;
  limit: number;
  pages: number;
  total: number;
  byStatus: Record<string, number>;
  items: {
    id: string;
    title: string;
    status: string;
    caseType: string;
    queue: string;
    customer: string;
    assignee: string | null;
    createdAt: string;
    dueAt: string | null;
    overdue: boolean;
    scope: "yours" | "shared";
    sources: string[];
  }[];
  sources: Source[];
  computedAt: string;
  definition: { rows: string; source: string };
  limits: { maxRangeDays: number; maxPageSize: number; exportRowCap: number };
};

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export function Reports() {
  useRouteFocus("Reports");
  const { state } = useSession();
  const caps = state.status === "ready" ? state.me.capabilities : [];
  const people = useLoad<{ items: { id: string; name: string }[] }>("/assignees");
  const [from, setFrom] = useState(isoDay(Date.now() - 365 * 86_400_000));
  const [to, setTo] = useState(isoDay(Date.now()));
  const [status, setStatus] = useState("");
  const [assignee, setAssignee] = useState("");
  const [source, setSource] = useState("");
  const [sort, setSort] = useState("created_desc");
  const [page, setPage] = useState(1);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ from, to, sort });
    if (status) p.set("status", status);
    if (assignee) p.set("assignee", assignee);
    if (source) p.set("source", source);
    return p.toString();
  }, [from, to, status, assignee, source, sort]);
  const { data, failure, reload } = useLoad<ReportResponse>(
    `/reports/operations?${qs}&page=${page}&limit=25`,
  );
  const reset = (fn: (v: string) => void) => (v: string) => {
    fn(v);
    setPage(1);
  };
  return (
    <>
      <Head title="Reports" route="/app/reports" />
      <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="Report filters">
        <label className="field">
          From (UTC)
          <input type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
        </label>
        <label className="field">
          To (UTC)
          <input type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} />
        </label>
        <label className="field">
          Status
          <select value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Assignee
          <select value={assignee} onChange={(e) => reset(setAssignee)(e.target.value)}>
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {people.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Source
          <select value={source} onChange={(e) => reset(setSource)(e.target.value)}>
            <option value="">Any source</option>
            <option value="crm_simulator">CRM simulator</option>
            <option value="erp_simulator">ERP simulator</option>
            <option value="none">No linked source</option>
          </select>
        </label>
        <label className="field">
          Sort
          <select value={sort} onChange={(e) => reset(setSort)(e.target.value)}>
            <option value="created_desc">Newest first</option>
            <option value="created_asc">Oldest first</option>
            <option value="due_asc">Due soonest</option>
            <option value="status">By status</option>
          </select>
        </label>
        {caps.includes("reports:export") &&
          (data && data.total > data.limits.exportRowCap ? (
            <p className="small" role="note">
              Export is off: {data.total.toLocaleString("en-US")} rows is over the{" "}
              {data.limits.exportRowCap.toLocaleString("en-US")}-row limit. Narrow the filters.
            </p>
          ) : (
            <a className="button" href={`/api/v1/reports/operations/export?${qs}`} download>
              Export CSV
            </a>
          ))}
      </form>
      <p className="sr-only" role="status">
        {data ? `${data.total} cases match.` : ""}
      </p>
      {failure && <ErrorCard failure={failure} onRetry={reload} />}
      {!data && !failure && <Skeleton label="Loading report" />}
      {data && (
        <div className="stack">
          <Section title={`${data.total} matching cases`} badge={<ProvenanceBadge p="SYNTHETIC" />}>
            <p className="small muted">
              {data.definition.rows} {data.definition.source} Limits: {data.limits.maxRangeDays}{" "}
              days per report, {data.limits.exportRowCap} rows per export. Calculated{" "}
              {when(data.computedAt)}.
            </p>
            {data.total === 0 ? (
              <p>No cases match these filters. Widen the dates or clear a filter.</p>
            ) : (
              <div className="split-even grid">
                <Bars
                  label="report-status"
                  rows={Object.entries(data.byStatus).map(([name, value]) => ({ name, value }))}
                />
                <Scroll label="Matching cases by status">
                  <table>
                    <caption>Matching cases by status (all pages)</caption>
                    <thead>
                      <tr>
                        <th scope="col">Status</th>
                        <th scope="col" className="r">
                          Cases
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(data.byStatus).map(([s, n]) => (
                        <tr key={s}>
                          <th scope="row">{s}</th>
                          <td className="r" data-status-count={s}>
                            {n}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroll>
              </div>
            )}
          </Section>
          <Section title="Source freshness">
            <ul className="bullets">
              {data.sources.map((s) => (
                <li key={`${s.shared}-${s.provider}`}>
                  {s.provider}
                  {s.shared ? " (shared sample)" : ""}: <SimBadge>{s.sourceLabel}</SimBadge> last
                  success {when(s.lastSuccessAt)}
                  {s.lastSuccessAt === null ? ", so data from it may be stale" : ""}.
                </li>
              ))}
            </ul>
          </Section>
          {data.items.length > 0 && (
            <section className="card" aria-label="Report rows">
              <Scroll label="Report rows">
                <table>
                  <caption>
                    Page {data.page} of {data.pages}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Case</th>
                      <th scope="col">Client</th>
                      <th scope="col">Status</th>
                      <th scope="col">Assignee</th>
                      <th scope="col">Created</th>
                      <th scope="col">Sources</th>
                      <th scope="col">Scope</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((r) => (
                      <tr key={r.id}>
                        <th scope="row">
                          <Link to={`/app/cases/${r.id}`}>{r.title}</Link>
                        </th>
                        <td>{r.customer}</td>
                        <td>
                          <StatusChip status={r.status} />
                        </td>
                        <td>{r.assignee ?? "Unassigned"}</td>
                        <td>{r.createdAt.slice(0, 10)}</td>
                        <td>{r.sources.join(", ") || "None"}</td>
                        <td>{r.scope === "yours" ? "Yours" : "Shared sample"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
              <nav className="actions" aria-label="Report pages">
                <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous page
                </button>
                <button
                  type="button"
                  disabled={page >= data.pages}
                  onClick={() => setPage(page + 1)}
                >
                  Next page
                </button>
              </nav>
            </section>
          )}
        </div>
      )}
    </>
  );
}

// --- P6.4 ROI --------------------------------------------------------------------------------

type ScenarioKey = keyof typeof SCENARIOS;

export function Roi() {
  useRouteFocus("ROI");
  const [inputs, setInputs] = useState<RoiInputs>(SCENARIOS.base);
  const [raw, setRaw] = useState<Record<InputKey, string>>(
    () => Object.fromEntries(INPUTS.map((d) => [d.key, String(SCENARIOS.base[d.key])])) as never,
  );
  const overview = useLoad<Overview>("/analytics/overview");
  const errors = validate(inputs);
  const ok = Object.keys(errors).length === 0;
  const result = ok ? calculate(inputs) : null;
  const sens = ok ? sensitivity(inputs).slice(0, 4) : [];
  const load = (k: ScenarioKey) => {
    setInputs(SCENARIOS[k]);
    setRaw(Object.fromEntries(INPUTS.map((d) => [d.key, String(SCENARIOS[k][d.key])])) as never);
  };
  const measured = overview.data?.ai.metrics.find((m) => m.key === "ai_decision_minutes");
  return (
    <>
      <Head title="ROI calculator" route="/app/roi" />
      <div className="stack">
        <p className="callout warn">
          <span className="t">
            <ProvenanceBadge p="ESTIMATED" /> {ROI_LABEL}
          </span>
          Every output below comes from the assumptions on this page. None is a saving anyone has
          achieved, and none of the defaults is an employer's or customer's number.
        </p>
        <Section
          title="Assumptions"
          badge={<span className="small mono">{ASSUMPTIONS_VERSION}</span>}
        >
          <div className="actions">
            {(Object.keys(SCENARIOS) as ScenarioKey[]).map((k) => (
              <button key={k} type="button" onClick={() => load(k)}>
                Load {k}
              </button>
            ))}
          </div>
          <div className="form-grid">
            {INPUTS.map((d) => (
              <label key={d.key} className="field">
                {d.label} ({d.unit})
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={d.max}
                  step={d.step}
                  value={raw[d.key]}
                  aria-invalid={errors[d.key] ? true : undefined}
                  aria-describedby={`src-${d.key}${errors[d.key] ? ` err-${d.key}` : ""}`}
                  onChange={(e) => {
                    setRaw({ ...raw, [d.key]: e.target.value });
                    setInputs({
                      ...inputs,
                      [d.key]: e.target.value === "" ? Number.NaN : Number(e.target.value),
                    });
                  }}
                />
                <span className="small muted" id={`src-${d.key}`}>
                  Source: {d.source}
                </span>
                {errors[d.key] && (
                  <span className="err" id={`err-${d.key}`}>
                    {errors[d.key]}
                  </span>
                )}
              </label>
            ))}
          </div>
        </Section>
        <Section title="Projection per month" badge={<ProvenanceBadge p="ESTIMATED" />}>
          <p className="sr-only" aria-live="polite">
            {result
              ? `Net value ${usd(result.netValue)} a month, estimated.`
              : "Fix the highlighted assumptions to see a projection."}
          </p>
          <div>
            {!result ? (
              <p>Fix the highlighted assumptions to see a projection.</p>
            ) : (
              <dl className="facts" data-roi="result">
                <div>
                  <dt>Hours saved (estimated)</dt>
                  <dd data-out="hours">{Math.round(result.grossHoursSaved * 10) / 10} h</dd>
                </div>
                <div>
                  <dt>Labor value (estimated)</dt>
                  <dd data-out="labor">{usd(result.laborValue)}</dd>
                </div>
                <div>
                  <dt>Modeled cost (estimated)</dt>
                  <dd data-out="cost">{usd(result.totalModeledCost)}</dd>
                </div>
                <div>
                  <dt>Net value (estimated)</dt>
                  <dd data-out="net">{usd(result.netValue)}</dd>
                </div>
                <div>
                  <dt>ROI (estimated)</dt>
                  <dd data-out="roi">
                    {result.roi === null
                      ? "Not defined: the modeled cost is zero"
                      : `${Math.round(result.roi * 100).toLocaleString("en-US")}%`}
                  </dd>
                </div>
                <div>
                  <dt>Break-even volume (estimated)</dt>
                  <dd data-out="breakeven">
                    {result.breakEvenTasks === null
                      ? "None: at these assumptions automation never pays back"
                      : `${result.breakEvenTasks.toLocaleString("en-US")} tasks a month`}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </Section>
        <Section
          title="Conservative, base and optimistic"
          badge={<ProvenanceBadge p="ESTIMATED" />}
        >
          <Scroll label="Scenarios side by side">
            <table>
              <caption>The three preset scenarios side by side. {ROI_LABEL}.</caption>
              <thead>
                <tr>
                  <th scope="col">Scenario</th>
                  <th scope="col" className="r">
                    Hours saved
                  </th>
                  <th scope="col" className="r">
                    Net value
                  </th>
                  <th scope="col" className="r">
                    ROI
                  </th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(SCENARIOS) as ScenarioKey[]).map((k) => {
                  const r = calculate(SCENARIOS[k]);
                  return (
                    <tr key={k}>
                      <th scope="row">{k}</th>
                      <td className="r">{Math.round(r.grossHoursSaved)} h</td>
                      <td className="r">{usd(r.netValue)}</td>
                      <td className="r">
                        {r.roi === null ? "Not defined" : `${Math.round(r.roi * 100)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Scroll>
        </Section>
        {ok && (
          <Section title="Which assumptions matter most">
            <Scroll label="Sensitivity">
              <table>
                <caption>Net value when one assumption moves 20% down or up, the rest held</caption>
                <thead>
                  <tr>
                    <th scope="col">Assumption</th>
                    <th scope="col" className="r">
                      20% lower
                    </th>
                    <th scope="col" className="r">
                      20% higher
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sens.map((s) => (
                    <tr key={s.key}>
                      <th scope="row">{s.label}</th>
                      <td className="r">{usd(s.low)}</td>
                      <td className="r">{usd(s.high)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          </Section>
        )}
        <Section
          title="Measured in this demo"
          badge={<ProvenanceBadge p={measured?.provenance ?? "UNKNOWN"} />}
        >
          <p>
            Median time from requesting an AI review to deciding it, in your own workspace:{" "}
            <strong>{measured ? formatMetric(measured) : "loading"}</strong>
            {overview.data ? ` (from ${overview.data.ai.decidedSample} decided reviews)` : ""}.
          </p>
          <p className="small muted">
            This is real timing from this session, kept apart from the projection above. It is not
            used in the ROI, because a handful of demo clicks says nothing about a team's workload.
          </p>
        </Section>
      </div>
    </>
  );
}
