import type { Db } from "../db";
import { FUNNEL, METRICS_VERSION } from "../domain/metrics";

// P6.3 limits, documented in docs/design/METRICS.md. Every report query is bounded by them.
export const REPORT_LIMITS = {
  maxRangeDays: 366,
  maxPageSize: 100,
  maxOffset: 5_000,
  exportRowCap: 1_000,
} as const;

export const REPORT_SOURCES = ["crm_simulator", "erp_simulator", "none"] as const;
export const REPORT_SORTS = ["created_desc", "created_asc", "due_asc", "status"] as const;

export type ReportFilters = {
  workspaceId: string;
  seesTemplate: boolean;
  from: string; // YYYY-MM-DD, inclusive, UTC
  to: string; // YYYY-MM-DD, inclusive, UTC
  status?: string;
  assigneeId?: string;
  unassigned?: boolean;
  source?: (typeof REPORT_SOURCES)[number];
  sort: (typeof REPORT_SORTS)[number];
};

const ORDER: Record<ReportFilters["sort"], string> = {
  created_desc: "c.created_at DESC, c.id DESC",
  created_asc: "c.created_at ASC, c.id ASC",
  due_asc: "c.due_at ASC NULLS LAST, c.id ASC",
  status: `array_position(ARRAY[${FUNNEL.map((s) => `'${s}'`).join(",")}]::text[], c.status), c.created_at DESC, c.id DESC`,
};

const HAS_LINK = (provider: string | null) =>
  `EXISTS (SELECT 1 FROM app.external_record_links l
            WHERE l.workspace_id = c.workspace_id AND l.canonical_type = 'customer'
              AND l.canonical_id = c.customer_id${provider ? ` AND l.provider = ${provider}` : ""})`;

// Built from fixed fragments; every value is a bind parameter. The same WHERE serves the table,
// the chart and the export, so all three count the same rows.
export function reportWhere(f: ReportFilters) {
  const values: unknown[] = [f.workspaceId, f.seesTemplate, f.from, f.to];
  const bind = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where = [
    `(c.workspace_id = $1 OR ($2::boolean AND c.workspace_id = (SELECT id FROM app.workspaces WHERE mode = 'template')))`,
    // UTC days whatever the session time zone: a bare date would be read in the server's zone.
    "c.created_at >= ($3::date)::timestamp AT TIME ZONE 'UTC'",
    "c.created_at < ($4::date + 1)::timestamp AT TIME ZONE 'UTC'",
  ];
  if (f.status) where.push(`c.status = ${bind(f.status)}`);
  if (f.assigneeId) where.push(`c.assignee_id = ${bind(f.assigneeId)}::uuid`);
  if (f.unassigned) where.push("c.assignee_id IS NULL");
  if (f.source === "none") where.push(`NOT ${HAS_LINK(null)}`);
  else if (f.source) where.push(HAS_LINK(bind(f.source)));
  return { where: where.join(" AND "), values };
}

const FROM = `FROM app.cases c
  JOIN app.customers cu ON cu.workspace_id = c.workspace_id AND cu.id = c.customer_id
  LEFT JOIN app.assignees a ON a.workspace_id = c.workspace_id AND a.id = c.assignee_id`;

const COLUMNS = `c.id, c.title, c.status, c.case_type, c.queue, c.created_at, c.due_at,
  cu.canonical_name AS customer, a.display_name AS assignee, c.workspace_id <> $1 AS shared,
  coalesce(c.due_at < now() AND c.status NOT IN ('Approved','Closed'), false) AS overdue,
  ARRAY(SELECT DISTINCT l.provider FROM app.external_record_links l
         WHERE l.workspace_id = c.workspace_id AND l.canonical_type = 'customer'
           AND l.canonical_id = c.customer_id ORDER BY l.provider) AS sources`;

export type ReportRow = {
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
};

const toRow = (r: Record<string, unknown>): ReportRow => ({
  id: r.id as string,
  title: r.title as string,
  status: r.status as string,
  caseType: r.case_type as string,
  queue: r.queue as string,
  customer: r.customer as string,
  assignee: (r.assignee as string | null) ?? null,
  createdAt: (r.created_at as Date).toISOString(),
  dueAt: r.due_at instanceof Date ? r.due_at.toISOString() : null,
  overdue: r.overdue as boolean,
  scope: r.shared ? "shared" : "yours",
  sources: (r.sources as string[]) ?? [],
});

export async function reportTotals(db: Db, f: ReportFilters) {
  const { where, values } = reportWhere(f);
  const { rows } = await db.query(
    `SELECT c.status, count(*)::int AS n ${FROM} WHERE ${where} GROUP BY c.status`,
    values,
  );
  const byStatus = Object.fromEntries(FUNNEL.map((s) => [s, 0])) as Record<string, number>;
  for (const r of rows) byStatus[r.status as string] = r.n as number;
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return { total, byStatus };
}

export async function reportPage(db: Db, f: ReportFilters, page: { page: number; limit: number }) {
  const { where, values } = reportWhere(f);
  const offset = (page.page - 1) * page.limit;
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM} WHERE ${where} ORDER BY ${ORDER[f.sort]}
      LIMIT ${page.limit} OFFSET ${offset}`,
    values,
  );
  return rows.map(toRow);
}

// Freshness for the sources this report can filter by, in the same scope.
export async function reportFreshness(
  db: Db,
  f: Pick<ReportFilters, "workspaceId" | "seesTemplate">,
) {
  const { rows } = await db.query(
    `SELECT x.provider, x.mode, x.status, x.last_success_at, x.workspace_id <> $1 AS shared
       FROM app.external_connections x
      WHERE (x.workspace_id = $1 OR ($2::boolean AND x.workspace_id = (SELECT id FROM app.workspaces WHERE mode = 'template')))
        AND x.provider IN ('crm_simulator','erp_simulator')
      ORDER BY shared, x.provider`,
    [f.workspaceId, f.seesTemplate],
  );
  return rows.map((r) => ({
    provider: r.provider as string,
    shared: r.shared as boolean,
    sourceLabel: r.mode === "simulated" ? "Simulated" : "Connected test",
    status: r.status as string,
    lastSuccessAt: r.last_success_at instanceof Date ? r.last_success_at.toISOString() : null,
  }));
}

export async function exportRows(db: Db, f: ReportFilters) {
  const { where, values } = reportWhere(f);
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM} WHERE ${where} ORDER BY ${ORDER[f.sort]}
      LIMIT ${REPORT_LIMITS.exportRowCap + 1}`,
    values,
  );
  return rows.map(toRow);
}

export const REPORT_DEFINITION = {
  definitionVersion: METRICS_VERSION,
  provenance: "SYNTHETIC",
  rows: "Cases created between from and to (UTC dates, inclusive) in your workspace, plus the shared read-only samples for a demo visitor.",
  source:
    "A case matches a source when its client has a linked record from that simulated system. 'none' means no linked record.",
} as const;

export const CSV_HEADER = [
  "Case",
  "Client",
  "Status",
  "Type",
  "Team",
  "Assignee",
  "Created (UTC)",
  "Due (UTC)",
  "Overdue",
  "Scope",
  "Sources",
  "Provenance",
];

export const csvRow = (r: ReportRow) => [
  r.title,
  r.customer,
  r.status,
  r.caseType,
  r.queue,
  r.assignee,
  r.createdAt,
  r.dueAt,
  r.overdue ? "yes" : "no",
  r.scope,
  r.sources.join(" "),
  "SYNTHETIC",
];
