import type { Db } from "../db";
import {
  ASSUMED_STEPS_PER_NOTICE,
  FIXTURE_EVALUATION,
  FUNNEL,
  GLOSSARY,
  METRICS_VERSION,
  type Provenance,
  PROVENANCE_TEXT,
  SNAPSHOT_KEYS,
  type SnapshotKey,
  UNRESOLVED_FINDING,
} from "../domain/metrics";

// The rows a request may count: its own workspace, plus the shared read-only template for a
// guest. This is the same set the case list shows, so a number on a dashboard matches a list.
export type AnalyticsScope = { workspaceId: string; seesTemplate: boolean };

const SCOPE_CTE = `scope AS (
  SELECT $1::uuid AS id
  UNION ALL SELECT id FROM app.workspaces WHERE $2::boolean AND mode = 'template')`;
const inScope = (alias: string) => `${alias}.workspace_id IN (SELECT id FROM scope)`;

const metric = (key: string, value: number | null, provenance?: Provenance) => {
  const d = GLOSSARY[key];
  if (!d) throw new Error(`metric ${key} has no definition`);
  return { key, label: d.label, unit: d.unit, provenance: provenance ?? d.provenance, value };
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);

export async function pulseAndFunnel(db: Db, s: AnalyticsScope) {
  const { rows } = await db.query(
    `WITH ${SCOPE_CTE}
     SELECT c.status, count(*)::int AS n,
            count(*) FILTER (WHERE c.due_at < now())::int AS overdue,
            max(floor(extract(epoch FROM now() - c.created_at) / 86400))::int AS oldest_days
       FROM app.cases c WHERE ${inScope("c")} GROUP BY c.status`,
    [s.workspaceId, s.seesTemplate],
  );
  const by = Object.fromEntries(rows.map((r) => [r.status as string, r]));
  const n = (status: string) => (by[status]?.n as number | undefined) ?? 0;
  const open = n("Intake") + n("Needs Review") + n("Ready");
  const done = n("Approved") + n("Closed");
  const nonDraft = FUNNEL.slice(1).reduce((a, st) => a + n(st), 0);
  const overdueOpen = ["Intake", "Needs Review", "Ready"].reduce(
    (a, st) => a + ((by[st]?.overdue as number | undefined) ?? 0),
    0,
  );
  // PRD 11.1: the funnel runs Intake to Closed; Drafts are counted in the pulse instead.
  // "Reached" counts a case in its stage and every later one: the funnel is one-directional
  // apart from reopen, which moves a case back and so out of the later count.
  const STAGES = FUNNEL.slice(1);
  const stages = STAGES.map((status, i) => ({
    status,
    count: n(status),
    reached: STAGES.slice(i).reduce((a, st) => a + n(st), 0),
  }));
  return {
    pulse: [
      metric("open_cases", open),
      metric("completed_cases", done),
      metric("draft_cases", n("Draft")),
      metric("review_queue", n("Needs Review")),
      metric(
        "review_age_max",
        num(by["Needs Review"]?.oldest_days),
        by["Needs Review"] ? "SYNTHETIC" : "UNKNOWN",
      ),
      metric("overdue_open", overdueOpen),
    ],
    funnel: {
      stages,
      completionRate: metric("completion_rate", nonDraft > 0 ? done / nonDraft : null),
      denominator: nonDraft,
    },
  };
}

const SOURCE_LABEL: Record<string, string> = {
  simulated: "Simulated",
  connected_test: "Connected test",
};

export async function integrationHealth(db: Db, s: AnalyticsScope) {
  const { rows } = await db.query(
    `WITH ${SCOPE_CTE}
     SELECT x.workspace_id <> $1 AS shared, x.provider, x.mode, x.status, x.last_success_at,
            x.last_error_code,
            count(r.id) FILTER (WHERE r.status = 'succeeded')::int AS succeeded,
            count(r.id) FILTER (WHERE r.status IN ('failed','dead_letter'))::int AS failed,
            coalesce(sum(r.resumes), 0)::int AS retries,
            coalesce(sum((SELECT coalesce(sum(v::int), 0) FROM jsonb_each_text(r.counts) e(k, v)
                           WHERE v ~ '^[0-9]{1,9}$')), 0)::int AS records
       FROM app.external_connections x
       LEFT JOIN app.sync_runs r ON r.workspace_id = x.workspace_id AND r.connection_id = x.id
      WHERE ${inScope("x")}
      GROUP BY x.workspace_id, x.id ORDER BY shared, x.provider`,
    [s.workspaceId, s.seesTemplate],
  );
  const sources = rows.map((r) => ({
    provider: r.provider as string,
    shared: r.shared as boolean,
    // PRD 11.1 and P6-D: say plainly whether the source is simulated. A connected test is a real
    // sandbox org reached over the network, not production data.
    sourceLabel: SOURCE_LABEL[r.mode as string] ?? "Unknown",
    live: r.mode === "connected_test",
    status: r.status as string,
    lastSuccessAt: iso(r.last_success_at),
    lastErrorCode: (r.last_error_code as string | null) ?? null,
    runsSucceeded: r.succeeded as number,
    runsFailed: r.failed as number,
    retries: r.retries as number,
    recordsProcessed: r.records as number,
  }));
  const latest = sources
    .map((x) => (x.lastSuccessAt ? Date.parse(x.lastSuccessAt) : null))
    .filter((x): x is number => x !== null)
    .sort((a, b) => b - a)[0];
  const ageHours = latest === undefined ? null : Math.floor((Date.now() - latest) / 3_600_000);
  return {
    sources,
    lastSyncAge: metric("last_sync_age", ageHours, ageHours === null ? "UNKNOWN" : "SYNTHETIC"),
    lastSuccessAt: latest === undefined ? null : new Date(latest).toISOString(),
  };
}

export async function dataQuality(db: Db, s: AnalyticsScope) {
  const kinds = await db.query(
    `WITH ${SCOPE_CTE}
     SELECT f.kind,
            count(*) FILTER (WHERE f.${UNRESOLVED_FINDING})::int AS unresolved,
            count(*) FILTER (WHERE f.status = 'Resolved')::int AS resolved,
            count(*) FILTER (WHERE f.status = 'Dismissed')::int AS dismissed,
            max(floor(extract(epoch FROM now() - f.detected_at) / 86400))
              FILTER (WHERE f.${UNRESOLVED_FINDING})::int AS oldest_days
       FROM app.reconciliation_findings f WHERE ${inScope("f")}
      GROUP BY f.kind ORDER BY f.kind`,
    [s.workspaceId, s.seesTemplate],
  );
  const fields = await db.query(
    `WITH ${SCOPE_CTE}
     SELECT d->>'field' AS field, count(*)::int AS n
       FROM app.reconciliation_findings f
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(f.source_values->'differences') = 'array'
             THEN f.source_values->'differences' ELSE '[]'::jsonb END) d
      WHERE ${inScope("f")} AND coalesce((d->>'normalizedEqual')::boolean, false) = false
        AND d ? 'field'
      GROUP BY 1 ORDER BY n DESC, field LIMIT 5`,
    [s.workspaceId, s.seesTemplate],
  );
  const byKind = kinds.rows.map((r) => ({
    kind: r.kind as string,
    unresolved: r.unresolved as number,
    resolved: r.resolved as number,
    dismissed: r.dismissed as number,
  }));
  const total = (k: "unresolved" | "resolved" | "dismissed") =>
    byKind.reduce((a, r) => a + r[k], 0);
  const oldest = kinds.rows
    .map((r) => r.oldest_days as number | null)
    .filter((d): d is number => d !== null);
  return {
    metrics: [
      metric("open_findings", total("unresolved")),
      metric("findings_resolved", total("resolved")),
      metric("findings_dismissed", total("dismissed")),
      oldest.length
        ? metric("oldest_unresolved", Math.max(...oldest))
        : metric("oldest_unresolved", null, "UNKNOWN"),
    ],
    byKind,
    mismatchedFields: fields.rows.map((r) => ({ field: r.field as string, count: r.n as number })),
  };
}

export async function aiAssistance(db: Db, s: AnalyticsScope, liveConfigured: boolean) {
  const reviews = await db.query(
    `WITH ${SCOPE_CTE}
     SELECT a.status, a.mode, count(*)::int AS n,
            count(*) FILTER (WHERE a.abstain_reason IS NOT NULL)::int AS abstained
       FROM app.ai_reviews a WHERE ${inScope("a")} GROUP BY 1, 2 ORDER BY 1, 2`,
    [s.workspaceId, s.seesTemplate],
  );
  const docs = await db.query(
    `WITH ${SCOPE_CTE}
     SELECT count(*)::int AS n FROM app.documents d WHERE ${inScope("d")}`,
    [s.workspaceId, s.seesTemplate],
  );
  // Own workspace only: this is timing from actions taken here, not seeded rows.
  const timing = await db.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (
              ORDER BY extract(epoch FROM decided_at - requested_at) / 60) AS median,
            count(*)::int AS n
       FROM app.ai_reviews WHERE workspace_id = $1 AND decided_at IS NOT NULL`,
    [s.workspaceId],
  );
  const cost = await db.query(
    "SELECT coalesce(sum(cost_micro_usd), 0)::bigint AS micro, coalesce(sum(requests), 0)::int AS requests FROM app.ai_usage WHERE workspace_id = $1",
    [s.workspaceId],
  );
  const byStatus: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  let abstained = 0;
  for (const r of reviews.rows) {
    byStatus[r.status as string] = (byStatus[r.status as string] ?? 0) + (r.n as number);
    byMode[r.mode as string] = (byMode[r.mode as string] ?? 0) + (r.n as number);
    abstained += r.abstained as number;
  }
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const median = num(timing.rows[0]?.median);
  const liveRequests = cost.rows[0]?.requests as number;
  // A live cost exists only once a live provider has been called. Until then it is unknown, not 0.
  const liveCost =
    liveConfigured && liveRequests > 0
      ? metric("ai_live_cost", Number(cost.rows[0]?.micro) / 1_000_000, "MEASURED_DEMO")
      : metric("ai_live_cost", null, "UNKNOWN");
  return {
    metrics: [
      metric("documents", docs.rows[0]?.n as number),
      metric("ai_reviews", total),
      metric("ai_abstained", abstained),
      metric(
        "ai_decision_minutes",
        median === null ? null : Math.round(median * 10) / 10,
        median === null ? "UNKNOWN" : "MEASURED_DEMO",
      ),
      liveCost,
    ],
    byStatus,
    byMode,
    decidedSample: timing.rows[0]?.n as number,
    liveState: liveConfigured ? "configured" : "pending_owner_credentials",
    evaluation: FIXTURE_EVALUATION,
  };
}

const LABEL_SQL = `CASE
  WHEN o.dispatch_state IN ('pending','processing','retry_scheduled') THEN 'Queued'
  WHEN o.dispatch_state = 'dead_letter' THEN 'Failed'
  WHEN o.dispatch_state = 'simulated' THEN 'Simulated'
  WHEN o.delivery_evidence = 'confirmed' THEN 'Confirmed'
  ELSE 'Accepted' END`;
export const DELIVERY_LABELS = ["Queued", "Accepted", "Confirmed", "Failed", "Simulated"] as const;

export async function automation(db: Db, s: AnalyticsScope) {
  const { rows } = await db.query(
    `WITH ${SCOPE_CTE}
     SELECT ${LABEL_SQL} AS label, count(*)::int AS n,
            coalesce(sum(greatest(o.attempts - 1, 0)), 0)::int AS retries
       FROM app.outbox o WHERE ${inScope("o")} GROUP BY 1`,
    [s.workspaceId, s.seesTemplate],
  );
  const byLabel = Object.fromEntries(DELIVERY_LABELS.map((l) => [l, 0])) as Record<string, number>;
  let retries = 0;
  for (const r of rows) {
    byLabel[r.label as string] = r.n as number;
    retries += r.retries as number;
  }
  const replaced = (byLabel.Accepted ?? 0) + (byLabel.Confirmed ?? 0) + (byLabel.Simulated ?? 0);
  return {
    byLabel,
    // PRD 9: Accepted means the provider took the request. Delivery is not known.
    acceptedNote: "Accepted means the receiving service took the request. Delivery is unconfirmed.",
    metrics: [
      metric("automation_retries", retries),
      metric("automation_failed", byLabel.Failed ?? 0),
      metric("manual_steps_avoided", replaced * ASSUMED_STEPS_PER_NOTICE),
    ],
    assumedStepsPerNotice: ASSUMED_STEPS_PER_NOTICE,
  };
}

export async function overview(db: Db, s: AnalyticsScope, liveConfigured: boolean) {
  const { pulse, funnel } = await pulseAndFunnel(db, s);
  const integration = await integrationHealth(db, s);
  const quality = await dataQuality(db, s);
  const ai = await aiAssistance(db, s, liveConfigured);
  const auto = await automation(db, s);
  const now = await db.query("SELECT now() AS at");
  return {
    definitionVersion: METRICS_VERSION,
    computedAt: iso(now.rows[0]?.at),
    scope: s.seesTemplate ? "workspace_and_shared_samples" : "workspace",
    provenanceText: PROVENANCE_TEXT,
    glossary: GLOSSARY,
    pulse: [...pulse, quality.metrics[0], integration.lastSyncAge],
    funnel,
    integration,
    quality,
    ai,
    automation: auto,
  };
}

// The value a snapshot records for each key, from the same functions the dashboard uses.
export async function currentSnapshotValues(db: Db, s: AnalyticsScope) {
  const { pulse } = await pulseAndFunnel(db, s);
  const q = await dataQuality(db, s);
  const a = await automation(db, s);
  const v = (list: { key: string; value: number | null }[], key: string) =>
    list.find((m) => m.key === key)?.value ?? 0;
  const values: Record<SnapshotKey, number> = {
    open_cases: v(pulse, "open_cases"),
    completed_cases: v(pulse, "completed_cases"),
    review_queue: v(pulse, "review_queue"),
    open_findings: v(q.metrics, "open_findings"),
    automation_failed: v(a.metrics, "automation_failed"),
  };
  return values;
}

// Own snapshots only, never the template's: a workspace records what it can see of itself.
export async function recordSnapshot(db: Db, workspaceId: string) {
  const values = await currentSnapshotValues(db, { workspaceId, seesTemplate: false });
  const { rows } = await db.query(
    `INSERT INTO app.metric_snapshots (workspace_id, period, metric_key, numerator, provenance,
                                       definition_version)
     SELECT $1, (now() AT TIME ZONE 'UTC')::date, k, v, 'SYNTHETIC', $4
       FROM unnest($2::text[], $3::numeric[]) AS t(k, v)
     ON CONFLICT (workspace_id, metric_key, period) DO UPDATE
       SET numerator = EXCLUDED.numerator, captured_at = now()
     RETURNING to_char(period, 'YYYY-MM-DD') AS period`,
    [workspaceId, SNAPSHOT_KEYS, SNAPSHOT_KEYS.map((k) => values[k]), METRICS_VERSION],
  );
  return { period: rows[0]?.period as string, values };
}

export const TREND_DAYS = 90;

export async function trend(db: Db, s: AnalyticsScope, key: SnapshotKey) {
  const { rows } = await db.query(
    `WITH ${SCOPE_CTE}
     SELECT to_char(m.period, 'YYYY-MM-DD') AS period, m.numerator, m.provenance,
            m.workspace_id <> $1 AS shared, m.captured_at
       FROM app.metric_snapshots m
      WHERE ${inScope("m")} AND m.metric_key = $3
      ORDER BY shared DESC, m.period DESC LIMIT ${TREND_DAYS * 2}`,
    [s.workspaceId, s.seesTemplate, key],
  );
  const series = (shared: boolean) =>
    rows
      .filter((r) => r.shared === shared)
      .slice(0, TREND_DAYS)
      .reverse()
      .map((r) => ({ period: r.period as string, value: Number(r.numerator) }));
  return {
    metric: key,
    label: GLOSSARY[key]?.label ?? key,
    shared: { provenance: "SYNTHETIC" as Provenance, points: series(true) },
    own: { provenance: "SYNTHETIC" as Provenance, points: series(false) },
  };
}
