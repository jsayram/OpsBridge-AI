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
          database. <Link to="/about/engineering">Engineering notes</Link> list what is tested and
          what is still simulated.
        </p>
        <h2>Status</h2>
        <p className="muted">
          This build covers the shell, identity boundary and isolated workspaces. The case workflow,
          reconciliation, automation, AI review and analytics arrive in later phases.
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
    You can also read <Link to="/about/engineering">the recorded walkthrough notes</Link>.
  </p>
);

const STEPS = [
  ["Launch a private workspace", "Done"],
  ["Create a sample case", "Arrives in P2"],
  ["Detect a mismatch between systems", "Arrives in P3"],
  ["Review a fixture document", "Arrives in P5"],
  ["Approve a resolution and see the recap", "Arrives in P4 and P6"],
] as const;

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
          <section className="stack">
            <p role="status">Your workspace is ready.</p>
            <Link to="/app/overview" className="button primary">
              Go to Overview
            </Link>
          </section>
        ) : (
          state.status !== "loading" && <LaunchPanel autostart={autostart} />
        )}
        <h2>The five steps</h2>
        <ol className="steps">
          {STEPS.map(([step, status]) => (
            <li key={step}>
              <span>{step}</span>
              <span className="small muted">{status}</span>
            </li>
          ))}
        </ol>
      </main>
    </>
  );
}

export function Engineering() {
  useRouteFocus("Engineering notes");
  return (
    <>
      <SkipLink />
      <Banner />
      <main className="page" id="main" tabIndex={-1}>
        <h1>Engineering notes</h1>
        <p>
          React and TypeScript on one Cloudflare Worker, PostgreSQL behind it, with row-level
          security under every query. <Link to="/">Back to the start</Link>.
        </p>
        <h2>What is real in this build</h2>
        <ul className="bullets">
          <li>Private demo workspaces, session cookies, quotas and reset</li>
          <li>Database roles, row-level security and an append-only audit table</li>
          <li>Request IDs, structured logs and security headers</li>
        </ul>
        <h2>What is simulated or pending</h2>
        <ul className="bullets">
          <li>Owner sign-in is built against a test double. The provider is not configured.</li>
          <li>No CRM, ERP, Zapier or AI provider is connected.</li>
          <li>Nothing here has been deployed or run through Hyperdrive yet.</li>
        </ul>
        <h2 id="walkthrough">Recorded walkthrough</h2>
        <p className="muted">The recording comes with the public launch in phase P8.</p>
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
