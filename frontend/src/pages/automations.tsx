import { type FormEvent, useRef, useState } from "react";
import { ApiFailure, api, intentKeys } from "../api";
import { ErrorCard, SimBadge, Skeleton } from "../components/ui";
import { useRouteFocus } from "../router";
import { can, useSession } from "../session";
import { Head, useLoad } from "./shared";

type Rule = {
  id: string;
  name: string;
  trigger: string;
  condition: Record<string, string>;
  conditionText: string;
  action: string;
  enabled: boolean;
  version: number;
  reusedFrom: string | null;
  reusable: boolean;
};
type RulesPage = {
  items: Rule[];
  status: { paused: boolean; reason: string | null };
  transport: string;
  teams: string[];
};
export type Run = {
  id: string;
  type: string;
  ref: string;
  label: "Queued" | "Accepted" | "Confirmed" | "Failed" | "Simulated";
  evidenceRef: string | null;
  attempts: number;
  lastErrorCode: string | null;
  nextAttemptAt: string | null;
  effects: { ruleId: string; ruleVersion: number; action: string; sink: string }[];
  createdAt: string;
  uncertain: boolean;
};
type RunDetail = Run & {
  history: {
    attempt: number;
    outcome: string;
    code: string | null;
    evidenceRef: string | null;
    at: string;
  }[];
};

const ACTION_LABEL: Record<string, string> = {
  sheet_append: "Append a row to the owner's test sheet",
  simulated_notice: "Record a simulated notice",
};
const SAMPLE: Record<string, Record<string, string>> = {
  "case.created": { queue: "Field Services", caseType: "Billing" },
  "case.needs_review": { queue: "Field Services", reason: "returned" },
  "approval.completed": { queue: "Field Services", decision: "approved" },
  "reconciliation.resolved": { kind: "definition_conflict" },
  "integration.degraded": { provider: "erp_simulator" },
};
// What each label means, stated plainly. "Delivered" is never shown: nothing here can prove it.
export const LABEL_HELP: Record<Run["label"], string> = {
  Queued: "Waiting for the dispatcher, or for a retry.",
  Accepted: "The provider took it. Whether anyone received it is not known.",
  Confirmed: "The owner recorded evidence that the action ran.",
  Failed: "Stopped after a permanent error or six attempts. Nothing is lost.",
  Simulated: "Recorded here. Nothing left the system.",
};
const TONE: Record<Run["label"], string> = {
  Queued: "info",
  Accepted: "warn",
  Confirmed: "ok",
  Failed: "bad",
  Simulated: "neutral",
};

export const LabelChip = ({ label }: { label: Run["label"] }) => (
  <span className={`chip ${TONE[label]}`} title={LABEL_HELP[label]}>
    {label}
  </span>
);

// A table that scrolls sideways has to be reachable from the keyboard even with no control in it.
const ScrollRegion = ({ label, children }: { label: string; children: React.ReactNode }) => (
  // biome-ignore lint/a11y/noNoninteractiveTabindex: the region scrolls, so it needs focus
  <section className="tscroll" tabIndex={0} aria-label={label}>
    {children}
  </section>
);

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");

function useCapability(capability: string) {
  const { state } = useSession();
  return state.status === "ready" && can(state.me, capability);
}

function RuleRow({
  rule,
  teams,
  onChanged,
}: {
  rule: Rule;
  teams: string[];
  onChanged: () => void;
}) {
  const manage = useCapability("automations:manage");
  const keys = useRef(intentKeys()).current;
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, intent?: string) => {
    setFailure(null);
    setBusy(true);
    try {
      await fn();
      if (intent) keys.settle();
      onChanged();
    } catch (e) {
      if (intent) keys.settle(e);
      if (e instanceof ApiFailure) setFailure(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  };
  const otherTeam = teams.find((t) => t !== rule.condition.queue);
  return (
    <tr>
      <th scope="row">
        {rule.name}
        <div className="small muted">
          v{rule.version}
          {rule.reusedFrom ? " · reused from another team's rule" : ""}
        </div>
      </th>
      <td className="mono small">{rule.trigger}</td>
      <td>{rule.conditionText}</td>
      <td>{ACTION_LABEL[rule.action] ?? rule.action}</td>
      <td>{rule.enabled ? "On" : "Off"}</td>
      {manage && (
        <td>
          <div className="row">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(`/automations/rules/${rule.id}`, {
                    method: "PATCH",
                    body: { version: rule.version, enabled: !rule.enabled },
                  }),
                )
              }
            >
              {rule.enabled ? "Turn off" : "Turn on"}
            </button>
            {rule.reusable && !rule.reusedFrom && otherTeam && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const intent = `reuse:${rule.id}:${otherTeam}`;
                  void act(
                    () =>
                      api(`/automations/rules/${rule.id}/reuse`, {
                        method: "POST",
                        body: { queue: otherTeam },
                        idempotencyKey: keys.keyFor(intent),
                      }),
                    intent,
                  );
                }}
              >
                Reuse for {otherTeam}
              </button>
            )}
          </div>
          {failure && (
            <p role="alert" className="small">
              {failure.message}
            </p>
          )}
        </td>
      )}
    </tr>
  );
}

function Simulator() {
  const [type, setType] = useState("approval.completed");
  const [data, setData] = useState<Record<string, string>>(SAMPLE["approval.completed"] ?? {});
  const [result, setResult] = useState<{ matched: { name: string }[]; outcome: string } | null>(
    null,
  );
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const run = async (e: FormEvent) => {
    e.preventDefault();
    setFailure(null);
    try {
      setResult(await api("/automations/simulate", { method: "POST", body: { type, data } }));
    } catch (err) {
      if (err instanceof ApiFailure) setFailure(err);
      else throw err;
    }
  };
  return (
    <section className="card">
      <h2>Try a rule</h2>
      <p className="muted small">
        A preview only. It shows which rules a sample event would match. Nothing is queued or sent.
      </p>
      <form className="row" onSubmit={run}>
        <label className="field">
          Event
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setData(SAMPLE[e.target.value] ?? {});
              setResult(null);
            }}
          >
            {Object.keys(SAMPLE).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {"queue" in data && (
          <label className="field">
            Team
            <select
              value={data.queue}
              onChange={(e) => setData({ ...data, queue: e.target.value })}
            >
              <option>Field Services</option>
              <option>Seasonal Staffing</option>
            </select>
          </label>
        )}
        <button type="submit">Preview</button>
      </form>
      {failure && <ErrorCard failure={failure} />}
      {result && (
        <div role="status">
          <p>
            {result.matched.length
              ? `Matches: ${result.matched.map((m) => m.name).join(", ")}.`
              : "No rule matches."}
          </p>
          <p className="muted small">{result.outcome}</p>
        </div>
      )}
    </section>
  );
}

function RunHistory({ id }: { id: string }) {
  const { data, failure } = useLoad<RunDetail>(`/automations/runs/${id}`);
  if (failure) return <ErrorCard failure={failure} />;
  if (!data) return <p className="small muted">Loading attempts…</p>;
  if (!data.history.length) return <p className="small muted">No attempt yet.</p>;
  return (
    <ol className="small">
      {data.history.map((h) => (
        <li key={`${h.attempt}-${h.at}`}>
          Attempt {h.attempt}: {h.outcome.replace("_", " ")}
          {h.code ? ` (${h.code})` : ""} at {when(h.at)}
        </li>
      ))}
    </ol>
  );
}

export function RunsTable({
  runs,
  actions,
}: {
  runs: Run[];
  actions?: (run: Run) => React.ReactNode;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!runs.length) {
    return (
      <p className="muted">No events yet. Approve a case or resolve a finding to create one.</p>
    );
  }
  return (
    <ScrollRegion label="Automation runs">
      <table>
        <caption>Newest first. A label says only what the evidence supports.</caption>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Label</th>
            <th scope="col">Attempts</th>
            <th scope="col">Rules matched</th>
            <th scope="col">Detail</th>
            {actions && <th scope="col">Operator</th>}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <th scope="row">
                <span className="mono small">{r.type}</span>
                <div className="small muted mono">{r.ref}</div>
                <div className="small muted">{when(r.createdAt)}</div>
              </th>
              <td>
                <LabelChip label={r.label} />
                <div className="small muted">{LABEL_HELP[r.label]}</div>
              </td>
              <td className="r">{r.attempts}</td>
              <td className="r">{r.effects.length}</td>
              <td>
                {r.lastErrorCode && <div className="small">Last error: {r.lastErrorCode}</div>}
                {r.nextAttemptAt && <div className="small">Next try: {when(r.nextAttemptAt)}</div>}
                {r.evidenceRef && <div className="small mono">{r.evidenceRef}</div>}
                <button
                  type="button"
                  aria-expanded={open === r.id}
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                >
                  {open === r.id ? "Hide attempts" : "Show attempts"}
                </button>
                {open === r.id && <RunHistory id={r.id} />}
              </td>
              {actions && <td>{actions(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

export function Automations() {
  useRouteFocus("Automations");
  const rules = useLoad<RulesPage>("/automations/rules");
  const runs = useLoad<{ items: Run[] }>("/automations/runs?limit=50");
  const manage = useCapability("automations:manage");
  const reload = () => {
    rules.reload();
    runs.reload();
  };
  return (
    <>
      <Head title="Automations" route="/app/automations" />
      <div className="stack">
        <p className="muted">
          Approved changes and resolved findings become events in a durable outbox. Rules decide
          what each event does. In a demo workspace every effect is <SimBadge />: nothing is sent to
          a sheet, a Zap or a mailbox.
        </p>
        {rules.data?.status.paused && (
          <section className="card state-panel" role="status">
            <h2>Automation is paused</h2>
            <p>
              The owner stopped all dispatch
              {rules.data.status.reason ? `: ${rules.data.status.reason}` : ""}. Events wait as
              Queued and none are lost.
            </p>
          </section>
        )}
        {rules.failure && <ErrorCard failure={rules.failure} onRetry={rules.reload} />}
        {!rules.data && !rules.failure && <Skeleton label="Loading rules" />}
        {rules.data && (
          <section className="card">
            <h2>Rules</h2>
            <p className="small muted">
              Destination: {rules.data.transport}. Rules can only use listed triggers, listed fields
              and listed actions; they hold no address, link or code.
            </p>
            <ScrollRegion label="Automation rules">
              <table>
                <caption>
                  Each change makes a new version, and every effect records the version it ran
                  under.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Rule</th>
                    <th scope="col">Trigger</th>
                    <th scope="col">When</th>
                    <th scope="col">Action</th>
                    <th scope="col">State</th>
                    {manage && <th scope="col">Change</th>}
                  </tr>
                </thead>
                <tbody>
                  {rules.data.items.map((r) => (
                    <RuleRow
                      key={r.id}
                      rule={r}
                      teams={rules.data?.teams ?? []}
                      onChanged={reload}
                    />
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </section>
        )}
        <Simulator />
        {runs.failure && <ErrorCard failure={runs.failure} onRetry={runs.reload} />}
        {!runs.data && !runs.failure && <Skeleton label="Loading runs" />}
        {runs.data && (
          <section className="card">
            <div className="row between">
              <h2>Runs</h2>
              <button type="button" onClick={runs.reload}>
                Refresh
              </button>
            </div>
            <RunsTable runs={runs.data.items} />
          </section>
        )}
      </div>
    </>
  );
}

type AdminAutomation = {
  paused: boolean;
  reason: string | null;
  sheetBridge: { configured: boolean; testDouble: boolean; claim: string };
  zapier: { claim: string; webhook: string };
};

// Owner only, on /admin. Pause, retry a failed run, and record Zap evidence for an accepted one.
export function AutomationAdmin() {
  const status = useLoad<AdminAutomation>("/admin/automations", { guestPath: false });
  const runs = useLoad<{ items: Run[] }>("/automations/runs?limit=25", { guestPath: false });
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const act = async (path: string, body?: unknown) => {
    setFailure(null);
    try {
      await api(path, { method: "POST", ...(body !== undefined ? { body } : {}) });
      status.reload();
      runs.reload();
    } catch (e) {
      if (e instanceof ApiFailure) setFailure(e);
      else throw e;
    }
  };
  const s = status.data;
  return (
    <section className="card">
      <h2>Automation controls</h2>
      {status.failure && <ErrorCard failure={status.failure} onRetry={status.reload} />}
      {s && (
        <>
          <p>
            Sheet bridge: <strong>{s.sheetBridge.claim}</strong>
            {s.sheetBridge.testDouble ? " (only a local test double is configured)" : ""}. Zapier:{" "}
            <strong>{s.zapier.claim}</strong>. Webhook: {s.zapier.webhook}.
          </p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                "/admin/automations/pause",
                s.paused ? { paused: false } : { paused: true, reason },
              );
            }}
          >
            {!s.paused && (
              <label className="field">
                Reason for stopping
                <input
                  value={reason}
                  maxLength={300}
                  required
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            )}
            <button type="submit" className={s.paused ? "primary" : "danger"}>
              {s.paused ? "Resume automation" : "Emergency stop"}
            </button>
          </form>
          <p className="small muted" role="status">
            {s.paused
              ? `Paused${s.reason ? `: ${s.reason}` : ""}. Events wait as Queued.`
              : "Running."}
          </p>
        </>
      )}
      {failure && <ErrorCard failure={failure} />}
      {runs.data && (
        <RunsTable
          runs={runs.data.items}
          actions={(r) =>
            r.label === "Failed" ? (
              <button
                type="button"
                onClick={() => void act(`/admin/automations/runs/${r.id}/retry`)}
              >
                Retry
              </button>
            ) : r.label === "Accepted" ? (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(`/admin/automations/runs/${r.id}/confirm`, {
                    evidenceRef: evidence[r.id] ?? "",
                  });
                }}
              >
                <label className="field small">
                  Zap run reference
                  <input
                    value={evidence[r.id] ?? ""}
                    maxLength={200}
                    required
                    onChange={(e) => setEvidence({ ...evidence, [r.id]: e.target.value })}
                  />
                </label>
                <button type="submit">Confirm</button>
              </form>
            ) : null
          }
        />
      )}
    </section>
  );
}
