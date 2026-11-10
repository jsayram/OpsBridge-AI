import { type Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import { type GuestActor, requireActor, requireCapability } from "../auth/actor";
import { isDemoRole } from "../auth/policy";
import { DEMO_COOKIE, hashToken, ipBucket, newDemoToken } from "../auth/tokens";
import { pgCode, withClient, withWorkspace } from "../db";
import type { AppEnv, Bindings } from "../env";
import { ApiError, invalidRequest } from "../http/errors";
import { log } from "../http/log";
import { clientIp } from "../http/middleware";
import { readStrictJson } from "../http/validate";

const PACK_VERSION = "pack-3";

const setSessionCookie = (c: Context<AppEnv>, token: string, maxAge: number) =>
  setCookie(c, DEMO_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge,
  });

const lifecycleError = (e: unknown): never => {
  switch (pgCode(e)) {
    case "P0003":
      throw new ApiError(503, "demo_capacity", "The demo is full right now. Try again later.");
    case "P0004":
      throw new ApiError(429, "launch_quota", "Too many demo launches. Try again within the hour.");
    case "P0005":
      throw new ApiError(429, "reset_quota", "This session has used all of its resets.");
    case "P0006":
      throw new ApiError(503, "demo_unavailable", "The demo is not available right now.");
    case "55P03": // lock_timeout
    case "57014": // statement_timeout
    case "40P01": // deadlock, reset meeting a purge at the expiry boundary
      throw new ApiError(503, "demo_busy", "The demo is busy. Try again in a moment.");
    default:
      throw e;
  }
};

const sessionBody = (row: { session_expires_at: Date; role: string }) => ({
  expiresAt: row.session_expires_at.toISOString(),
  packVersion: PACK_VERSION,
  demoRole: row.role,
});

const demoAvailable = (env: Bindings): string => {
  if (env.DEMO_LAUNCH_PAUSED === "true") {
    throw new ApiError(503, "demo_paused", "New demo sessions are paused.");
  }
  if (!env.IP_HASH_KEY) {
    log({ level: "error", event: "config_missing", code: "ip_hash_key" });
    throw new ApiError(503, "demo_unavailable", "The demo is not available right now.");
  }
  return env.IP_HASH_KEY;
};

const maxAge = (expiresAt: Date) =>
  Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));

export const demo = new Hono<AppEnv>();

demo.post("/sessions", async (c) => {
  const key = demoAvailable(c.env);
  const token = newDemoToken();
  const tokenHash = await hashToken(token);
  const bucket = await ipBucket(key, clientIp(c));
  const { rows } = await withClient(c.env.HYPERDRIVE, (db) =>
    db
      .query("SELECT * FROM app.launch_demo_session($1, $2)", [tokenHash, bucket])
      .catch(lifecycleError),
  );
  setSessionCookie(c, token, maxAge(rows[0].session_expires_at));
  return c.json(sessionBody(rows[0]), 201);
});

demo.post("/reset", requireActor, requireCapability("demo:reset"), async (c) => {
  const key = demoAvailable(c.env);
  const actor = c.get("actor") as GuestActor;
  const token = newDemoToken();
  const newHash = await hashToken(token);
  const bucket = await ipBucket(key, clientIp(c));
  const { rows } = await withClient(c.env.HYPERDRIVE, (db) =>
    db
      .query("SELECT * FROM app.reset_demo_session($1, $2, $3)", [actor.tokenHash, newHash, bucket])
      .catch(lifecycleError),
  );
  const row = rows[0];
  if (!row) throw new ApiError(401, "session_expired", "Your demo session has ended");
  setSessionCookie(c, token, maxAge(row.session_expires_at));
  return c.json(sessionBody(row));
});

demo.post("/role", requireActor, requireCapability("demo:switch_role"), async (c) => {
  const actor = c.get("actor") as GuestActor;
  const { role } = await readStrictJson(c, ["role"]);
  if (!isDemoRole(role)) throw invalidRequest("Role must be viewer, analyst or manager");
  const { rows } = await withClient(c.env.HYPERDRIVE, (db) =>
    db.query("SELECT app.set_demo_role($1, $2) AS role", [actor.tokenHash, role]),
  );
  if (!rows[0]?.role) throw new ApiError(401, "session_expired", "Your demo session has ended");
  return c.json({ demoRole: rows[0].role });
});

// P8.1: the guided checklist. Every step is read back from this workspace's own records, so the
// page can't mark a step done that didn't happen, and a reset (a new workspace) starts it over.
// Only the visitor's own actions count: the audit rows must come from a demo session, and a
// detected mismatch is a finding a sync opened here (pack findings carry a pack_key).
const STEP_ACTIONS = {
  case_created: ["case.created"],
  document_reviewed: ["ai_review.decided"],
  resolution_approved: ["approval.completed", "finding.approved"],
} as const;

demo.get("/progress", requireActor, async (c) => {
  const actor = c.get("actor");
  if (actor.kind !== "guest") {
    throw new ApiError(404, "not_found", "The guided demo is for demo sessions.");
  }
  const actions = Object.values(STEP_ACTIONS).flat();
  const out = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, async (db) => {
    const ws = await db.query("SELECT created_at FROM app.workspaces WHERE id = $1", [
      actor.workspaceId,
    ]);
    // approval.completed is written for a rejection too; only an approval counts for step 5.
    const audit = await db.query(
      `SELECT action, min(occurred_at) AS first_at, count(*)::int AS n
         FROM app.audit_events
        WHERE workspace_id = $1 AND actor_type = 'demo_session' AND action = ANY($2)
          AND (action <> 'approval.completed' OR summary LIKE 'approved%')
        GROUP BY action`,
      [actor.workspaceId, actions],
    );
    const findings = await db.query(
      `SELECT count(*)::int AS n FROM app.reconciliation_findings
        WHERE workspace_id = $1 AND pack_key IS NULL`,
      [actor.workspaceId],
    );
    const firstFinding = await db.query(
      `SELECT min(occurred_at) AS first_at FROM app.audit_events
        WHERE workspace_id = $1 AND actor_type = 'demo_session' AND action = 'sync.finished'
          AND $2::int > 0`,
      [actor.workspaceId, findings.rows[0].n],
    );
    const runs = await db.query(
      `SELECT dispatch_state, count(*)::int AS n FROM app.outbox
        WHERE workspace_id = $1 GROUP BY 1`,
      [actor.workspaceId],
    );
    const written = await db.query(
      `SELECT count(*)::int AS n FROM app.audit_events
        WHERE workspace_id = $1 AND actor_type = 'demo_session' AND actor_role IS NOT NULL`,
      [actor.workspaceId],
    );
    return {
      startedAt: ws.rows[0].created_at as Date,
      audit: new Map(audit.rows.map((r) => [r.action as string, r])),
      findingsOpened: findings.rows[0].n as number,
      findingAt: (firstFinding.rows[0]?.first_at ?? null) as Date | null,
      runs: Object.fromEntries(runs.rows.map((r) => [r.dispatch_state, r.n])) as Record<
        string,
        number
      >,
      written: written.rows[0].n as number,
    };
  });
  const first = (names: readonly string[]) => {
    const times = names
      .map((n) => out.audit.get(n)?.first_at as Date | undefined)
      .filter((t): t is Date => Boolean(t));
    return times.length ? new Date(Math.min(...times.map((t) => t.getTime()))) : null;
  };
  const count = (names: readonly string[]) =>
    names.reduce((sum, n) => sum + ((out.audit.get(n)?.n as number | undefined) ?? 0), 0);
  const steps = [
    { key: "workspace_launched", completedAt: out.startedAt },
    { key: "case_created", completedAt: first(STEP_ACTIONS.case_created) },
    { key: "mismatch_detected", completedAt: out.findingAt },
    { key: "document_reviewed", completedAt: first(STEP_ACTIONS.document_reviewed) },
    { key: "resolution_approved", completedAt: first(STEP_ACTIONS.resolution_approved) },
  ].map((s) => ({ key: s.key, done: s.completedAt !== null, completedAt: iso(s.completedAt) }));
  const done = steps.every((s) => s.done);
  const lastAt = done
    ? Math.max(...steps.map((s) => new Date(s.completedAt as string).getTime()))
    : null;
  return c.json({
    provenance: "SYNTHETIC",
    startedAt: out.startedAt.toISOString(),
    complete: done,
    elapsedSeconds: lastAt === null ? null : Math.round((lastAt - out.startedAt.getTime()) / 1000),
    steps,
    recap: {
      casesCreated: count(STEP_ACTIONS.case_created),
      findingsOpened: out.findingsOpened,
      reviewsDecided: count(STEP_ACTIONS.document_reviewed),
      approvals: count(STEP_ACTIONS.resolution_approved),
      auditEventsWritten: out.written,
      automationRuns: Object.values(out.runs).reduce((a, b) => a + b, 0),
      automationRunsSimulated: out.runs.simulated ?? 0,
      sources: "Simulated",
      aiReview: "Deterministic fixture",
      delivery: "Simulated",
    },
  });
});

const iso = (d: Date | null) => (d ? d.toISOString() : null);
