import { type ChangeEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ApiFailure, api, type Me } from "../api";
import { Link } from "../router";
import { can, useSession } from "../session";
import { SimBadge } from "./ui";

export const Banner = () => (
  <div className="sim-banner" role="note">
    <span className="glyph" aria-hidden="true">
      ▲
    </span>
    Simulated demo. All names and numbers are synthetic, and no real system is connected.
  </div>
);

export const SkipLink = () => (
  <a className="skip-link" href="#main">
    Skip to main content
  </a>
);

const NAV = [
  ["/demo", "Guided demo"],
  ["/app/overview", "Overview"],
  ["/app/cases", "Cases"],
  ["/app/reconciliation", "Reconciliation"],
  ["/app/inventory", "Inventory"],
  ["/app/automations", "Automations"],
  ["/app/analytics", "Analytics"],
  ["/app/reports", "Reports"],
  ["/app/roi", "ROI"],
  ["/app/integrations", "Integrations"],
] as const;

const formatLeft = (seconds: number) => {
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};

function useCountdown(initialSeconds: number, expiresAt: string, onEnd: () => void) {
  const [left, setLeft] = useState(initialSeconds);
  // biome-ignore lint/correctness/useExhaustiveDependencies: expiresAt changes on reset, which restarts the clock
  useEffect(() => {
    const deadline = Date.now() + initialSeconds * 1000;
    const tick = () => {
      const next = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      setLeft(next);
      if (next === 0) onEnd();
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, [initialSeconds, expiresAt, onEnd]);
  return left;
}

function GuestControls({ me }: { me: Extract<Me, { kind: "guest" }> }) {
  const { refresh, sessionEnded } = useSession();
  const left = useCountdown(me.expiresInSeconds, me.expiresAt, sessionEnded);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const resetButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  // The control that held focus goes away, so hand focus to its replacement.
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
    else if (restoreFocus.current) resetButton.current?.focus();
    restoreFocus.current = false;
  }, [confirming]);

  const closeConfirm = () => {
    restoreFocus.current = true;
    setConfirming(false);
  };

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      await refresh();
      setMessage(done);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) sessionEnded();
      else setMessage(e instanceof ApiFailure ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
      if (confirming) closeConfirm();
    }
  };

  const onRole = (e: ChangeEvent<HTMLSelectElement>) => {
    const role = e.target.value;
    void run(
      () => api("/demo/role", { method: "POST", body: { role } }),
      `Role changed to ${role}.`,
    );
  };

  return (
    <div className="controls">
      <span className="small muted">
        Session ends in <span className="num">{formatLeft(left)}</span>
      </span>
      <span className="sr-only" role="status">
        {left > 0 && left <= 300 ? "Your demo session ends in less than five minutes." : ""}
      </span>
      <span>
        <label htmlFor="demo-role">Demo role (simulation)</label>
        <select id="demo-role" value={me.demoRole} onChange={onRole} aria-busy={busy}>
          <option value="viewer">Viewer</option>
          <option value="analyst">Analyst</option>
          <option value="manager">Manager</option>
        </select>
      </span>
      {can(me, "demo:reset") &&
        (confirming ? (
          <>
            <button
              ref={confirmButton}
              type="button"
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api("/demo/reset", { method: "POST" }),
                  "Demo reset to a fresh workspace.",
                )
              }
            >
              Confirm reset
            </button>
            <button type="button" disabled={busy} onClick={closeConfirm}>
              Cancel
            </button>
          </>
        ) : (
          <button ref={resetButton} type="button" onClick={() => setConfirming(true)}>
            Reset demo
          </button>
        ))}
      <span className="sr-only" role="status" aria-live="polite">
        {message}
      </span>
      {message && <span className="small muted">{message}</span>}
    </div>
  );
}

function ThemeToggle() {
  const [light, setLight] = useState(() => document.documentElement.dataset.theme === "light");
  const toggle = () => {
    const next = !light;
    setLight(next);
    document.documentElement.dataset.theme = next ? "light" : "dark";
    try {
      localStorage.setItem("opsbridge-theme", next ? "light" : "dark");
    } catch {
      /* preference only lasts this page view */
    }
  };
  return (
    <button type="button" aria-pressed={light} onClick={toggle}>
      Light theme
    </button>
  );
}

export function Shell({
  path,
  me,
  children,
}: {
  path: string;
  me: Me | null;
  children: ReactNode;
}) {
  return (
    <>
      <SkipLink />
      <Banner />
      <header className="topbar">
        <div className="brand">
          <Link to="/">
            OpsBridge <span>AI</span>
          </Link>
        </div>
        {me?.kind === "guest" && (
          <div className="workspace">
            Workspace: {me.workspaceName} · Environment: {me.environment} <SimBadge />
          </div>
        )}
        {me?.kind === "guest" && <GuestControls me={me} />}
        <ThemeToggle />
      </header>
      <div className="shell">
        <nav className="sidenav" aria-label="Primary">
          <ul>
            {NAV.map(([to, label]) => (
              <li key={to}>
                <Link to={to} current={path === to || path.startsWith(`${to}/`)}>
                  {label}
                  <span className="route">{to}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </>
  );
}
