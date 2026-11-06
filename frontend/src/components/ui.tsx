import type { ReactNode } from "react";
import type { ApiFailure } from "../api";
import { Link } from "../router";

const STATUS: Record<string, { tone: string; glyph: string }> = {
  Draft: { tone: "neutral", glyph: "○" },
  Intake: { tone: "info", glyph: "◔" },
  "Needs Review": { tone: "warn", glyph: "▲" },
  Ready: { tone: "info", glyph: "◑" },
  Approved: { tone: "ok", glyph: "✓" },
  Closed: { tone: "neutral", glyph: "■" },
};

export function StatusChip({ status }: { status: string }) {
  const { tone, glyph } = STATUS[status] ?? { tone: "neutral", glyph: "○" };
  return (
    <span className={`chip ${tone}`}>
      <span className="g" aria-hidden="true">
        {glyph}
      </span>
      {status}
    </span>
  );
}

export const SimBadge = ({ children = "Simulated" }: { children?: ReactNode }) => (
  <span className="badge sim">{children}</span>
);

export const Skeleton = ({ label }: { label: string }) => (
  <div className="card" role="status" aria-label={label}>
    <div className="skel-block" aria-hidden="true">
      <div className="skel lg w80" />
      <div className="skel w60" />
      <div className="skel w40" />
    </div>
  </div>
);

export function ErrorCard({
  failure,
  onRetry,
  retryLabel = "Retry",
}: {
  failure: ApiFailure;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <section className="card state-panel" role="alert">
      <h2>{failure.status === 403 ? "Access denied" : "That didn't work"}</h2>
      <p>{failure.message}</p>
      {failure.requestId && (
        <p className="small muted">
          Request ID: <span className="mono">{failure.requestId}</span>
        </p>
      )}
      {onRetry && (
        <button type="button" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </section>
  );
}

export function SessionNotice({ expired }: { expired: boolean }) {
  return (
    <section className="card state-panel" role="alert">
      <h2>{expired ? "Your demo session has ended" : "No demo session"}</h2>
      <p className="muted">
        {expired
          ? "Demo workspaces last two hours, then their data is removed. Start over for a fresh one."
          : "This area needs a demo session. Starting one takes a few seconds and needs no sign-up."}
      </p>
      <Link to="/demo" className="button primary">
        {expired ? "Start over" : "Go to the demo"}
      </Link>
    </section>
  );
}
