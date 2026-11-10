import { type Context, Hono } from "hono";
import { requireActor, requireCapability } from "../auth/actor";
import { gatewayState } from "../ai/gateway";
import { withWorkspace } from "../db";
import { CASE_STATUSES } from "../domain/caseStatus";
import { toCsv } from "../domain/csv";
import { SNAPSHOT_KEYS } from "../domain/metrics";
import type { AppEnv } from "../env";
import { ApiError, invalidRequest } from "../http/errors";
import { log } from "../http/log";
import { isUuid, requireOneOf } from "../http/validate";
import { overview, recordSnapshot, trend } from "../repo/analytics";
import { commandContext, writeAudit } from "../repo/records";
import {
  CSV_HEADER,
  csvRow,
  exportRows,
  REPORT_DEFINITION,
  REPORT_LIMITS,
  REPORT_SORTS,
  REPORT_SOURCES,
  type ReportFilters,
  reportFreshness,
  reportPage,
  reportTotals,
} from "../repo/reports";

const scopeOf = (c: Context<AppEnv>) => {
  const actor = c.get("actor");
  return { workspaceId: actor.workspaceId, seesTemplate: actor.kind === "guest" };
};

// A query parameter the route doesn't know is refused, not ignored, so nobody can believe a
// workspace or row-limit override took effect.
const onlyParams = (c: Context, allowed: readonly string[]) => {
  for (const key of Object.keys(c.req.queries())) {
    if (!allowed.includes(key)) throw invalidRequest(`Unknown parameter ${key.slice(0, 40)}`);
  }
  for (const [key, list] of Object.entries(c.req.queries())) {
    if (list.length > 1) throw invalidRequest(`Repeated parameter ${key}`);
  }
};

export const analytics = new Hono<AppEnv>();

analytics.use("*", requireActor, requireCapability("analytics:read"));

analytics.get("/overview", async (c) => {
  onlyParams(c, []);
  const scope = scopeOf(c);
  const live = c.get("actor").kind === "owner" && gatewayState(c.env).ready;
  return c.json(
    await withWorkspace(c.env.HYPERDRIVE, scope.workspaceId, (db) => overview(db, scope, live)),
  );
});

analytics.get("/trends", async (c) => {
  onlyParams(c, ["metric"]);
  const key = requireOneOf(c.req.query("metric"), SNAPSHOT_KEYS, "metric");
  const scope = scopeOf(c);
  return c.json(
    await withWorkspace(c.env.HYPERDRIVE, scope.workspaceId, (db) => trend(db, scope, key)),
  );
});

// Records today's values for the caller's own workspace. One row per metric and UTC day, so a
// repeat replaces the day's values instead of adding rows.
analytics.post("/snapshots", requireCapability("analytics:snapshot"), async (c) => {
  onlyParams(c, []);
  const actor = c.get("actor");
  const out = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, async (db) => {
    const ctx = commandContext(db, actor, c.get("requestId"));
    const result = await recordSnapshot(db, actor.workspaceId);
    await writeAudit(ctx, "analytics.snapshot_recorded", result.period, {
      after: result.values,
      summary: "Recorded today's metric snapshot",
    });
    return result;
  });
  return c.json(out, 201);
});

// --- P6.3 self-serve reports -------------------------------------------------------------

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (value: string, label: string) => {
  if (!DATE.test(value)) throw invalidRequest(`Bad ${label} date`);
  const t = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) {
    throw invalidRequest(`Bad ${label} date`);
  }
  return t;
};

const FILTER_PARAMS = ["from", "to", "status", "assignee", "source", "sort"] as const;

export function reportFilters(c: Context<AppEnv>): ReportFilters {
  const q = c.req.query();
  // Today as a UTC day, so an omitted "to" counts as a whole day like a given one.
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const toT = q.to === undefined ? today : realDate(q.to, "to");
  const fromT =
    q.from === undefined
      ? toT - (REPORT_LIMITS.maxRangeDays - 1) * DAY_MS
      : realDate(q.from, "from");
  if (fromT > toT) throw invalidRequest("The from date is after the to date");
  if ((toT - fromT) / DAY_MS + 1 > REPORT_LIMITS.maxRangeDays) {
    throw new ApiError(
      400,
      "range_too_large",
      `A report covers at most ${REPORT_LIMITS.maxRangeDays} days. Narrow the dates.`,
    );
  }
  const f: ReportFilters = {
    ...scopeOf(c),
    from: new Date(fromT).toISOString().slice(0, 10),
    to: new Date(toT).toISOString().slice(0, 10),
    sort: q.sort === undefined ? "created_desc" : requireOneOf(q.sort, REPORT_SORTS, "sort"),
  };
  if (q.status !== undefined) f.status = requireOneOf(q.status, CASE_STATUSES, "status");
  if (q.source !== undefined) f.source = requireOneOf(q.source, REPORT_SOURCES, "source");
  if (q.assignee === "unassigned") f.unassigned = true;
  else if (q.assignee !== undefined) {
    if (!isUuid(q.assignee)) throw invalidRequest("Bad assignee");
    f.assigneeId = q.assignee.toLowerCase();
  }
  return f;
}

const echo = (f: ReportFilters) => ({
  from: f.from,
  to: f.to,
  status: f.status ?? null,
  assignee: f.unassigned ? "unassigned" : (f.assigneeId ?? null),
  source: f.source ?? null,
  sort: f.sort,
});

export const reports = new Hono<AppEnv>();

reports.use("*", requireActor, requireCapability("analytics:read"));

reports.get("/operations", async (c) => {
  onlyParams(c, [...FILTER_PARAMS, "page", "limit"]);
  const f = reportFilters(c);
  const limit = Number(c.req.query("limit") ?? 25);
  const page = Number(c.req.query("page") ?? 1);
  if (!Number.isInteger(limit) || limit < 1 || limit > REPORT_LIMITS.maxPageSize) {
    throw invalidRequest(`Page size must be 1 to ${REPORT_LIMITS.maxPageSize}`);
  }
  if (!Number.isInteger(page) || page < 1 || (page - 1) * limit > REPORT_LIMITS.maxOffset) {
    throw invalidRequest("Bad page");
  }
  const out = await withWorkspace(c.env.HYPERDRIVE, f.workspaceId, async (db) => {
    const totals = await reportTotals(db, f);
    const items = await reportPage(db, f, { page, limit });
    const freshness = await reportFreshness(db, f);
    const now = await db.query("SELECT now() AS at");
    return {
      totals,
      items,
      freshness,
      computedAt: new Date(now.rows[0]?.at as Date).toISOString(),
    };
  });
  return c.json({
    filters: echo(f),
    page,
    limit,
    pages: Math.ceil(out.totals.total / limit),
    total: out.totals.total,
    byStatus: out.totals.byStatus,
    items: out.items,
    sources: out.freshness,
    computedAt: out.computedAt,
    definition: REPORT_DEFINITION,
    limits: REPORT_LIMITS,
  });
});

reports.get("/operations/export", requireCapability("reports:export"), async (c) => {
  onlyParams(c, FILTER_PARAMS);
  const f = reportFilters(c);
  const rows = await withWorkspace(c.env.HYPERDRIVE, f.workspaceId, (db) => exportRows(db, f));
  // Refused rather than cut short: a silently truncated export reads as the whole answer.
  if (rows.length > REPORT_LIMITS.exportRowCap) {
    throw new ApiError(
      413,
      "export_too_large",
      `An export holds at most ${REPORT_LIMITS.exportRowCap} rows. Narrow the filters.`,
    );
  }
  log({
    level: "info",
    event: "report_exported",
    requestId: c.get("requestId"),
    rows: rows.length,
  });
  const name = `opsbridge-operations-synthetic-${f.from}-to-${f.to}.csv`;
  return c.body(toCsv(CSV_HEADER, rows.map(csvRow)), 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${name}"`,
    "x-row-count": String(rows.length),
  });
});
