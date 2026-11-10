import type { Db } from "../db";

export type CaseQuery = {
  workspaceId: string;
  seesTemplate: boolean;
  limit: number;
  status?: string;
  queue?: string;
  caseType?: string;
  assigneeId?: string;
  unassigned?: boolean;
  overdue?: boolean;
  search?: string;
  cursor?: { rank: 0 | 1; at: string; id: string };
};

const OVERDUE = `coalesce(c.due_at < now() AND c.status NOT IN ('Approved','Closed'), false)`;

const COLUMNS = `c.id, c.title, c.case_type, c.status, c.due_at, c.version, c.queue, c.assignee_id,
       c.created_at, c.customer_id, cu.canonical_name AS customer, a.display_name AS assignee,
       to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
       c.workspace_id <> $1 AS read_only, ${OVERDUE} AS overdue,
       floor(extract(epoch FROM now() - c.created_at) / 86400)::int AS age_days`;

const FROM = `FROM app.cases c
  JOIN app.customers cu ON cu.workspace_id = c.workspace_id AND cu.id = c.customer_id
  LEFT JOIN app.assignees a ON a.workspace_id = c.workspace_id AND a.id = c.assignee_id`;

const TEMPLATE_ID = `(SELECT id FROM app.workspaces WHERE mode = 'template')`;

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

// Built from fixed fragments, and every value is a bind parameter. Own rows come first, then
// shared template rows, each from its own index-ordered branch so a page never sorts the lot.
export function casePageSql(q: CaseQuery): { text: string; values: unknown[] } {
  const values: unknown[] = [q.workspaceId];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const filters: string[] = [];
  if (q.status) filters.push(`c.status = ${bind(q.status)}`);
  if (q.queue) filters.push(`c.queue = ${bind(q.queue)}`);
  if (q.caseType) filters.push(`c.case_type = ${bind(q.caseType)}`);
  if (q.assigneeId) filters.push(`c.assignee_id = ${bind(q.assigneeId)}::uuid`);
  if (q.unassigned) filters.push("c.assignee_id IS NULL");
  if (q.overdue) filters.push(OVERDUE);
  if (q.search) {
    const p = bind(likePattern(q.search));
    filters.push(`(c.title ILIKE ${p} OR cu.canonical_name ILIKE ${p})`);
  }
  const shared = filters.map((f) => `AND ${f} `).join("");
  const take = bind(q.limit + 1);
  const after = q.cursor
    ? `AND (c.created_at, c.id) < (${bind(q.cursor.at)}::timestamptz, ${bind(q.cursor.id)}::uuid) `
    : "";
  const branch = (workspace: string, rank: 0 | 1, keyset: string) =>
    `(SELECT ${COLUMNS}, ${rank} AS rank ${FROM}
       WHERE c.workspace_id = ${workspace} ${shared}${keyset}
       ORDER BY c.created_at DESC, c.id DESC LIMIT ${take})`;
  const branches: string[] = [];
  if (q.cursor?.rank !== 1) branches.push(branch("$1", 0, after));
  if (q.seesTemplate) branches.push(branch(TEMPLATE_ID, 1, q.cursor?.rank === 1 ? after : ""));
  return {
    text: `SELECT * FROM (${branches.join(" UNION ALL ")}) page
            ORDER BY page.rank, page.created_at DESC, page.id DESC LIMIT ${take}`,
    values,
  };
}

export const caseDto = (r: Record<string, unknown>) => ({
  id: r.id,
  title: r.title,
  caseType: r.case_type,
  status: r.status,
  dueAt: r.due_at instanceof Date ? r.due_at.toISOString() : null,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : null,
  version: r.version,
  customer: r.customer,
  queue: r.queue,
  assigneeId: r.assignee_id ?? null,
  assignee: r.assignee ?? null,
  overdue: r.overdue,
  ageDays: r.age_days,
  readOnly: r.read_only,
});

export async function listCases(db: Db, q: CaseQuery) {
  const { text, values } = casePageSql(q);
  const { rows } = await db.query(text, values);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    items: page.map(caseDto),
    ...(rows.length > q.limit && last
      ? { nextCursor: `${last.rank}_${last.cursor_at}_${last.id}` }
      : {}),
  };
}

// Both id and workspace appear in every lookup. RLS is the second lock, not the first.
export async function findCase(db: Db, workspaceId: string, seesTemplate: boolean, id: string) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM}
      WHERE c.id = $2 AND (c.workspace_id = $1 OR ($3 AND c.workspace_id = ${TEMPLATE_ID}))`,
    [workspaceId, id, seesTemplate],
  );
  return rows[0];
}

// Takes the row lock every workflow command shares, so a checklist change can't slip between
// a transition's prerequisite check and its update.
export async function lockCase(db: Db, workspaceId: string, id: string) {
  const { rows } = await db.query(
    "SELECT id FROM app.cases WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    [workspaceId, id],
  );
  return rows[0];
}

export async function loadChecklist(db: Db, workspaceId: string, caseId: string) {
  const { rows } = await db.query(
    `SELECT id, item_key, label, required, state, evidence_ref, version
       FROM app.case_checklist_items WHERE workspace_id = $1 AND case_id = $2
      ORDER BY position, item_key`,
    [workspaceId, caseId],
  );
  return rows;
}

// What the source systems say about this case's client, for whoever picks the case up. Read-only.
async function sourceReferences(db: Db, workspaceId: string, customerId: string) {
  const links = await db.query(
    `SELECT l.provider, l.external_type, l.external_id, l.last_seen, r.relationship_role
       FROM app.external_record_links l
       LEFT JOIN app.customer_source_relationships r
         ON r.workspace_id = l.workspace_id AND r.external_record_link_id = l.id
      WHERE l.workspace_id = $1 AND l.canonical_type = 'customer' AND l.canonical_id = $2
      ORDER BY l.provider, l.external_id LIMIT 20`,
    [workspaceId, customerId],
  );
  const open = await db.query(
    `SELECT id, kind, severity, status FROM app.reconciliation_findings
      WHERE workspace_id = $1 AND entity_type = 'customer' AND entity_id = $2
        AND status IN ('Open','Investigating','Proposed','Deferred')
      ORDER BY detected_at DESC, id LIMIT 10`,
    [workspaceId, customerId],
  );
  return {
    links: links.rows.map((l) => ({
      provider: l.provider,
      recordType: l.external_type,
      externalId: l.external_id,
      role: l.relationship_role,
      lastSeen: l.last_seen.toISOString(),
    })),
    openFindings: open.rows,
  };
}

export async function caseDetail(db: Db, row: Record<string, unknown>, ownWorkspace: string) {
  const id = row.id as string;
  const workspaceId = row.read_only
    ? (await db.query(`SELECT ${TEMPLATE_ID} AS id`)).rows[0].id
    : ownWorkspace;
  const checklist = await loadChecklist(db, workspaceId, id);
  const handoffs = await db.query(
    `SELECT h.id, h.from_queue, h.to_queue, h.due_at, h.reason, h.open_required, h.occurred_at,
            f.display_name AS from_assignee, t.display_name AS to_assignee,
            i.canonical_item_code AS item_code
       FROM app.consultant_handoffs h
       LEFT JOIN app.assignees f ON f.workspace_id = h.workspace_id AND f.id = h.from_assignee_id
       LEFT JOIN app.assignees t ON t.workspace_id = h.workspace_id AND t.id = h.to_assignee_id
       LEFT JOIN app.inventory_items i ON i.workspace_id = h.workspace_id AND i.id = h.inventory_item_id
      WHERE h.workspace_id = $1 AND h.case_id = $2
      ORDER BY h.occurred_at DESC, h.id LIMIT 50`,
    [workspaceId, id],
  );
  const approval = await db.query(
    `SELECT id, status, reason, created_at, decided_at FROM app.approvals
      WHERE workspace_id = $1 AND case_id = $2 ORDER BY created_at DESC, id LIMIT 1`,
    [workspaceId, id],
  );
  const documents = await db.query(
    `SELECT id, title, category, status FROM app.documents
      WHERE workspace_id = $1 AND case_id = $2 ORDER BY title LIMIT 50`,
    [workspaceId, id],
  );
  const latest = approval.rows[0];
  return {
    ...caseDto(row),
    checklist: checklist.map((i) => ({
      id: i.id,
      key: i.item_key,
      label: i.label,
      required: i.required,
      state: i.state,
      evidenceRef: i.evidence_ref,
      version: i.version,
    })),
    handoffs: handoffs.rows.map((h) => ({
      id: h.id,
      fromAssignee: h.from_assignee,
      toAssignee: h.to_assignee,
      fromQueue: h.from_queue,
      toQueue: h.to_queue,
      dueAt: h.due_at?.toISOString() ?? null,
      reason: h.reason,
      openRequired: h.open_required,
      occurredAt: h.occurred_at.toISOString(),
      itemCode: h.item_code,
    })),
    sourceReferences: await sourceReferences(db, workspaceId, row.customer_id as string),
    approval: latest
      ? {
          id: latest.id,
          status: latest.status,
          reason: latest.reason,
          createdAt: latest.created_at.toISOString(),
          decidedAt: latest.decided_at?.toISOString() ?? null,
        }
      : null,
    documents: documents.rows,
  };
}

export async function caseActivity(
  db: Db,
  workspaceId: string,
  caseId: string,
  limit: number,
  beforeId?: string,
) {
  const { rows } = await db.query(
    `SELECT id, actor_type, actor_role, action, summary, occurred_at FROM app.audit_events
      WHERE workspace_id = $1 AND target = $2 AND ($3::bigint IS NULL OR id < $3::bigint)
      ORDER BY id DESC LIMIT $4`,
    [workspaceId, caseId, beforeId ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  return {
    // Session and user IDs stay server-side. A timeline only needs the role that acted.
    items: page.map((r) => ({
      id: r.id,
      action: r.action,
      actor: r.actor_role ?? r.actor_type,
      summary: r.summary,
      occurredAt: r.occurred_at.toISOString(),
    })),
    ...(rows.length > limit ? { nextCursor: page.at(-1)?.id } : {}),
  };
}
