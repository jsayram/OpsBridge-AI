import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, api } from "../api";
import { Banner, SkipLink } from "../components/Shell";
import { ErrorCard } from "../components/ui";
import { Link, navigate, useRouteFocus } from "../router";
import { useSession } from "../session";

// The landing page is static. It makes no API call, so a first visit can't wake the database.
export function Landing() {
  useRouteFocus("Enterprise operations demo");
  return (
    <>
      <SkipLink />
      <Banner />
      <main className="hero" id="main" tabIndex={-1}>
        <h1>OpsBridge AI</h1>
        <p className="lead">
          An operations command center for a fictional services business: cases, reconciliation
          between systems, human-reviewed document checks and automation with honest delivery
          labels.
        </p>
        <button
          type="button"
          className="primary"
          onClick={() => navigate("/demo", { autostart: true })}
        >
          Launch Guided Demo
        </button>
        <p className="muted small">
          No sign-up. You get a private synthetic workspace for two hours.
        </p>
        <h2>How it is built</h2>
        <p className="muted">
          One Cloudflare Worker serves the app and its API from one origin, with PostgreSQL behind
          it. Each visitor gets an isolated workspace, enforced by the API and again by the
          database. <Link to="/about/engineering">Engineering evidence</Link> lists what is tested
          and what is still simulated.
        </p>
        <h2>Status</h2>
        <p className="muted">
          Cases, reconciliation, automation, document review and analytics all work in the demo.
          Everything runs on synthetic data with simulated sources. The engineering evidence says
          what the tests showed and what is still pending.
        </p>
        <p className="small muted">
          Independent portfolio project. All data is synthetic, and it isn't affiliated with any
          named vendor or employer.
        </p>
      </main>
    </>
  );
}

type LaunchStage = "idle" | "starting" | "slow" | "retry" | "walkthrough";

const SLOW_MS = 1000;
const RETRY_MS = 8000;
const WALKTHROUGH_MS = 15_000;

function useLaunch(onDone: () => Promise<void>) {
  const [stage, setStage] = useState<LaunchStage>("idle");
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const abort = useRef<AbortController | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clear = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const launch = useCallback(async () => {
    clear();
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setFailure(null);
    setStage("starting");
    timers.current = [
      setTimeout(() => setStage("slow"), SLOW_MS),
      setTimeout(() => setStage("retry"), RETRY_MS),
      setTimeout(() => setStage("walkthrough"), WALKTHROUGH_MS),
    ];
    try {
      await api("/demo/sessions", { method: "POST", signal: controller.signal });
      clear();
      await onDone();
      setStage("idle");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      clear();
      setStage("idle");
      setFailure(
        e instanceof ApiFailure ? e : new ApiFailure(0, "unknown", "Launch failed.", null),
      );
    }
  }, [clear, onDone]);

  useEffect(
    () => () => {
      clear();
      abort.current?.abort();
    },
    [clear],
  );

  return { stage, failure, launch };
}

function LaunchPanel({ autostart }: { autostart: boolean }) {
  const { refresh } = useSession();
  const { stage, failure, launch } = useLaunch(refresh);
  const started = useRef(false);

  useEffect(() => {
    if (autostart && !started.current) {
      started.current = true;
      window.history.replaceState(null, "", "/demo");
      void launch();
    }
  }, [autostart, launch]);

  const busy = stage !== "idle";
  const limited =
    failure?.status === 429 || failure?.code === "demo_capacity" || failure?.code === "demo_paused";
  return (
    <section className="stack">
      {!busy && (
        <button type="button" className="primary" onClick={() => void launch()}>
          Launch Guided Demo
        </button>
      )}
      <div role="status" aria-live="polite">
        {busy && stage !== "starting" && (
          <div className="card state-panel">
            <h2>Starting your demo workspace</h2>
            <p className="muted">
              Starting your demo workspace. This can take a few seconds the first time.
            </p>
            <div className="skel-block" aria-hidden="true">
              <div className="skel w80" />
              <div className="skel w60" />
            </div>
          </div>
        )}
      </div>
      {(stage === "retry" || stage === "walkthrough") && (
        <button type="button" onClick={() => void launch()}>
          Retry
        </button>
      )}
      {stage === "walkthrough" && <WalkthroughLink />}
      {failure && (
        <ErrorCard failure={failure} {...(limited ? {} : { onRetry: () => void launch() })} />
      )}
      {limited && <WalkthroughLink />}
    </section>
  );
}

const WalkthroughLink = () => (
  <p className="muted">
    You can also read <Link to="/about/engineering#walkthrough">the written walkthrough</Link> and
    the engineering evidence without a workspace.
  </p>
);

type StepKey =
  | "workspace_launched"
  | "case_created"
  | "mismatch_detected"
  | "document_reviewed"
  | "resolution_approved";

export type DemoProgress = {
  provenance: "SYNTHETIC";
  startedAt: string;
  complete: boolean;
  elapsedSeconds: number | null;
  steps: { key: StepKey; done: boolean; completedAt: string | null }[];
  recap: {
    casesCreated: number;
    findingsOpened: number;
    reviewsDecided: number;
    approvals: number;
    auditEventsWritten: number;
    automationRuns: number;
    automationRunsSimulated: number;
    sources: string;
    aiReview: string;
    delivery: string;
  };
};

// The five steps and where each one happens. The server decides what is done; this table only
// says what to do and where. It is also the offline fallback: if progress can't load, the steps
// and links still work, because none of them needs an outside provider.
const STEPS: { key: StepKey; title: string; to: string | null; link: string; how: string }[] = [
  {
    key: "workspace_launched",
    title: "Launch a private workspace",
    to: null,
    link: "",
    how: "The server copies a fixed synthetic scenario into a workspace only you can see.",
  },
  {
    key: "case_created",
    title: "Create a sample case",
    to: "/app/cases",
    link: "Open Cases",
    how: "Press New case, type a title, press Create case. The case opens with its activity history.",
  },
  {
    key: "mismatch_detected",
    title: "Detect a mismatch between systems",
    to: "/app/integrations",
    link: "Open Integrations",
    how: "On the ERP Simulator card pick the scenario Customer renamed and press Run simulated sync. Reconciliation then lists a Name mismatch with both values side by side.",
  },
  {
    key: "document_reviewed",
    title: "Review a fixture document",
    to: "/app/cases",
    link: "Open Cases",
    how: "Open an Intake case, attach a fictional document, press Request review, then Accept, Edit or Reject the labeled fixture suggestion. Each field cites the page it came from.",
  },
  {
    key: "resolution_approved",
    title: "Approve a resolution",
    to: "/app/cases",
    link: "Open Cases",
    how: "Open a Ready case and press Approve. That writes audit history, records a Simulated automation run and updates Analytics.",
  },
];

const duration = (seconds: number) =>
  seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;

function useProgress(enabled: boolean) {
  const [data, setData] = useState<DemoProgress | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce forces a reload
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setFailure(null);
    api<DemoProgress>("/demo/progress", { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setFailure(
          e instanceof ApiFailure ? e : new ApiFailure(0, "unknown", "Progress failed.", null),
        );
      });
    return () => controller.abort();
  }, [enabled, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, failure, reload, clear: () => setData(null) };
}

function Checklist({ progress }: { progress: DemoProgress | null }) {
  const done = new Map(progress?.steps.map((s) => [s.key, s]) ?? []);
  return (
    <ol className="steps guided" aria-label="Guided demo steps">
      {STEPS.map((step, i) => {
        const state = done.get(step.key);
        const finished = Boolean(state?.done);
        return (
          <li key={step.key} className={finished ? "done" : undefined}>
            <div className="step-text">
              <span className="step-title">
                <span className="sr-only">Step {i + 1}: </span>
                {step.title}
              </span>
              <span className="small muted">{step.how}</span>
            </div>
            <span className="step-side">
              <span className={`chip ${finished ? "ok" : "neutral"}`}>
                {!progress ? "Unknown" : finished ? "Done" : "To do"}
              </span>
              {step.to && (
                <Link to={step.to} className="small">
                  {step.link}
                  <span className="sr-only"> for step {i + 1}</span>
                </Link>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Recap({ progress }: { progress: DemoProgress }) {
  const r = progress.recap;
  return (
    <section className="card stack" aria-labelledby="recap-h">
      <h2 id="recap-h" tabIndex={-1}>
        Recap
      </h2>
      {progress.elapsedSeconds !== null && (
        <p>
          All five steps done in <span className="num">{duration(progress.elapsedSeconds)}</span>,
          timed by the server from launch to your last step.
        </p>
      )}
      <h3>What happened</h3>
      <ul className="bullets">
        <li>
          {r.casesCreated} case{r.casesCreated === 1 ? "" : "s"} created, each with an activity
          history.
        </li>
        <li>
          {r.findingsOpened} mismatch{r.findingsOpened === 1 ? "" : "es"} found by a simulated sync.
          No customer record was changed by it.
        </li>
        <li>
          {r.reviewsDecided} document review{r.reviewsDecided === 1 ? "" : "s"} decided by you. Only
          an accept changes a case.
        </li>
        <li>
          {r.approvals} approval{r.approvals === 1 ? "" : "s"}, and {r.automationRuns} automation
          run{r.automationRuns === 1 ? "" : "s"} recorded ({r.automationRunsSimulated} Simulated).
        </li>
        <li>{r.auditEventsWritten} audit events written by your actions.</li>
      </ul>
      <h3>What was simulated</h3>
      <ul className="bullets">
        <li>Sources: {r.sources}. The CRM and ERP are simulators, not live systems.</li>
        <li>Document review: {r.aiReview}. No language model was called.</li>
        <li>Automation delivery: {r.delivery}. Nothing left this workspace.</li>
      </ul>
      <h3>What was measured</h3>
      <p className="muted">
        Nothing on this page is a measurement of a real business. Every count above is read from
        your workspace's synthetic records. The engineering evidence page lists what the tests
        measured.
      </p>
      <p>
        <Link to="/app/analytics">See the dashboards</Link> ·{" "}
        <Link to="/app/automations">See the automation runs</Link> ·{" "}
        <Link to="/about/engineering">Engineering evidence</Link>
      </p>
    </section>
  );
}

function GuidedRun() {
  const { state, refresh, sessionEnded } = useSession();
  const me = state.status === "ready" && state.me.kind === "guest" ? state.me : null;
  const { data, failure, reload, clear } = useProgress(Boolean(me));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
    else if (wasConfirming.current) resetButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  if (!me) return null;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      await refresh();
      reload();
      setMessage(done);
      return true;
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) sessionEnded();
      else setMessage(e instanceof ApiFailure ? e.message : "That didn't work.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    clear();
    const ok = await act(
      () => api("/demo/reset", { method: "POST" }),
      "Demo reset. The checklist starts over in a fresh workspace.",
    );
    wasConfirming.current = false;
    setConfirming(false);
    if (ok) heading.current?.focus();
  };

  const remaining = data ? data.steps.filter((s) => !s.done).length : null;
  return (
    <section className="stack" aria-labelledby="checklist-h">
      <h2 id="checklist-h" ref={heading} tabIndex={-1}>
        Your checklist
      </h2>
      <p className="muted small" role="status" aria-live="polite">
        {data
          ? data.complete
            ? "All five steps are done."
            : `${5 - (remaining ?? 0)} of 5 steps done.`
          : failure
            ? "Progress couldn't load. The steps below still work."
            : "Loading progress."}
      </p>
      {me.demoRole !== "manager" && (
        <div className="callout">
          <p className="small">
            You're using the {me.demoRole} role. Deciding a review and approving need the Manager
            role.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(
                () => api("/demo/role", { method: "POST", body: { role: "manager" } }),
                "Role changed to manager.",
              )
            }
          >
            Use the Manager role
          </button>
        </div>
      )}
      <Checklist progress={data} />
      {failure && <ErrorCard failure={failure} onRetry={reload} />}
      <div className="actions">
        <button type="button" onClick={reload} disabled={busy}>
          Refresh progress
        </button>
        {confirming ? (
          <>
            <button
              ref={confirmButton}
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void reset()}
            >
              Confirm reset
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button ref={resetButton} type="button" onClick={() => setConfirming(true)}>
            Reset Demo
          </button>
        )}
      </div>
      <p className="small muted" role="status" aria-live="polite">
        {message}
      </p>
      {data?.complete && <Recap progress={data} />}
    </section>
  );
}

export function Demo() {
  useRouteFocus("Guided demo");
  const { state } = useSession();
  const autostart = useRef(
    (window.history.state as { autostart?: boolean } | null)?.autostart === true,
  ).current;
  const active = state.status === "ready" && state.me.kind === "guest";
  return (
    <>
      <SkipLink />
      <Banner />
      <main className="page" id="main" tabIndex={-1}>
        <h1>Guided demo</h1>
        {active && (
          <section className="stack">
            <p role="status">Your workspace is ready.</p>
            <Link to="/app/overview" className="button primary">
              Go to Overview
            </Link>
          </section>
        )}
        <div className="callout">
          <p className="t">Synthetic data only</p>
          <p className="small">
            Northstar Operations and every client here are fictional. Don't enter real information.
            Nothing you do leaves this workspace, and it is removed after two hours.
          </p>
        </div>
        {state.status === "loading" && (
          <p className="muted" role="status">
            Checking for a session.
          </p>
        )}
        {active ? (
          <GuidedRun />
        ) : (
          state.status !== "loading" && (
            <>
              <LaunchPanel autostart={autostart} />
              <h2>The five steps</h2>
              <Checklist progress={null} />
            </>
          )
        )}
        <h2>If a provider is offline</h2>
        <p className="muted small">
          The guided demo never needs Salesforce, Zapier, Google or an AI provider. Sources are
          simulators, document reviews are labeled fixtures and automation runs are recorded as
          Simulated, so the steps work the same with every outside service switched off. Come back
          here from the Guided demo link in the menu.
        </p>
      </main>
    </>
  );
}

// E2E-28: public engineering evidence. Static text, no API call, nothing from the owner side.
// Every figure is copied from a dated local run named in docs/reports; update it only from a
// new run, never by hand-editing a number.
const EVIDENCE_RUN = "Local clean-copy run on Node 22, 2026-11-09, at the P8 head";
const RESULTS: [string, string][] = [
  ["Unit tests", "233 passed"],
  ["Integration tests on real PostgreSQL", "412 passed"],
  ["Query profile", "11 passed"],
  ["AI evaluation, fixture mode, 40 documents", "3 of 3 threshold checks passed"],
  ["Browser tests on workerd, Chromium desktop and phone", "Passed, 6 skipped by design"],
  ["Dependency audit", "0 known vulnerabilities"],
  ["Secret scan of the tree and history", "No leaks"],
];

export function Engineering() {
  useRouteFocus("Engineering evidence");
  return (
    <>
      <SkipLink />
      <Banner />
      <main className="page" id="main" tabIndex={-1}>
        <h1>Engineering evidence</h1>
        <p>
          React and TypeScript on one Cloudflare Worker, PostgreSQL behind it, with row-level
          security under every query. This page lists what the tests showed and what is still
          pending. <Link to="/">Back to the start</Link>.
        </p>
        <h2>Latest test results</h2>
        <p className="small muted">{EVIDENCE_RUN}. The same steps run in the repository's CI.</p>
        <table className="evidence">
          <caption className="sr-only">Test results</caption>
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {RESULTS.map(([check, result]) => (
              <tr key={check}>
                <th scope="row">{check}</th>
                <td>{result}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2>What is real in this build</h2>
        <ul className="bullets">
          <li>Private demo workspaces with session cookies, quotas, reset and automatic cleanup</li>
          <li>Database roles, row-level security and an append-only audit table</li>
          <li>Case workflow with checklists, handoffs and version-checked approvals</li>
          <li>Reconciliation that shows both source values and leaves the decision to a person</li>
          <li>A transactional outbox with retries, a dead-letter state and operator controls</li>
          <li>Document review whose every field cites its page, decided by a person</li>
          <li>Dashboards computed from the records, each number labeled</li>
          <li>Rehearsed restore and rollback, an incident runbook and a negative security sweep</li>
        </ul>
        <h2>What is simulated or pending</h2>
        <ul className="bullets">
          <li>
            The CRM and ERP are simulators. The ERP follows NetSuite REST conventions and is not
            NetSuite.
          </li>
          <li>
            Salesforce, the Google Sheet and Zapier bridge, the live AI provider and owner sign-in
            are built and tested against labeled test doubles. None is connected.
          </li>
          <li>Every document review is a deterministic fixture. No language model is called.</li>
          <li>ROI figures are illustrative projections from stated assumptions, not savings.</li>
          <li>
            The test figures above come from a local machine. Hosted timings, a real Safari and
            iPhone run, and a screen-reader pass by a person are still pending.
          </li>
          <li>
            All reviews of the code so far are AI-run. No independent human review has happened.
          </li>
        </ul>
        <h2>Performance on a local machine</h2>
        <p className="muted">
          Twenty simulated visitors for 60 seconds: no errors, and the slowest route's 95th
          percentile was 475 ms. That was measured on a laptop, not on the hosted service.
        </p>
        <h2 id="walkthrough">Written walkthrough</h2>
        <p className="muted">
          No video is published yet. This is what a visitor does in the guided demo, in about five
          minutes:
        </p>
        <ol className="bullets">
          {STEPS.map((step) => (
            <li key={step.key}>
              <strong>{step.title}.</strong> {step.how}
            </li>
          ))}
        </ol>
        <p className="muted">
          A recap then lists what happened, what was simulated and what was measured, and Reset Demo
          starts over in a fresh workspace.
        </p>
      </main>
    </>
  );
}

export function NotFoundPage() {
  useRouteFocus("Page not found");
  return (
    <>
      <SkipLink />
      <Banner />
      <main className="page" id="main" tabIndex={-1}>
        <h1>Page not found</h1>
        <p>
          <Link to="/">Back to the start</Link>
        </p>
      </main>
    </>
  );
}
