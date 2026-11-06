import { Hono } from "hono";
import { requireActor, requireCapability } from "../auth/actor";
import { hashHex } from "../auth/tokens";
import { type Db, withWorkspace } from "../db";
import type { AppEnv } from "../env";
import { ApiError, forbidden, invalidRequest, notFound } from "../http/errors";
import { isUuid, readStrictJson } from "../http/validate";

const STATUSES = ["Draft", "Intake", "Needs Review", "Ready", "Approved", "Closed"];
const MAX_VERSION = 2_147_483_647;
const MAX_TITLE = 200;

const SELECT = `SELECT c.id, c.title, c.case_type, c.status, c.due_at, c.version,
                       cu.canonical_name AS customer, c.workspace_id <> $1 AS read_only
                  FROM app.cases c
                  JOIN app.customers cu ON cu.workspace_id = c.workspace_id AND cu.id = c.customer_id`;

// Both id and workspace appear in every lookup. RLS is the second lock, not the first.
const SCOPE = `(c.workspace_id = $1
  OR ($2 AND c.workspace_id = (SELECT id FROM app.workspaces WHERE mode = 'template')))`;

const dto = (r: Record<string, unknown>) => ({
  id: r.id,
  title: r.title,
  caseType: r.case_type,
  status: r.status,
  dueAt: r.due_at instanceof Date ? r.due_at.toISOString() : null,
  version: r.version,
  customer: r.customer,
  readOnly: r.read_only,
});

const findCase = async (db: Db, workspaceId: string, seesTemplate: boolean, id: string) =>
  (await db.query(`${SELECT} WHERE ${SCOPE} AND c.id = $3`, [workspaceId, seesTemplate, id]))
    .rows[0];

export const cases = new Hono<AppEnv>();

cases.use("*", requireActor, requireCapability("cases:read"));

cases.get("/", async (c) => {
  const actor = c.get("actor");
  const seesTemplate = actor.kind === "guest";
  const limit = Number(c.req.query("limit") ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidRequest("Bad limit");
  const status = c.req.query("status");
  if (status !== undefined && !STATUSES.includes(status)) throw invalidRequest("Bad status");
  const cursor = c.req.query("cursor");
  const [rank, afterId] = cursor ? cursor.split(":") : [null, null];
  if (cursor !== undefined && !((rank === "0" || rank === "1") && isUuid(afterId ?? ""))) {
    throw invalidRequest("Bad cursor");
  }
  const { rows } = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    db.query(
      `${SELECT} WHERE ${SCOPE}
         AND ($3::text IS NULL OR c.status = $3)
         AND ($4::int IS NULL OR ((c.workspace_id <> $1)::int, c.id) > ($4::int, $5::uuid))
       ORDER BY (c.workspace_id <> $1)::int, c.id
       LIMIT $6`,
      [actor.workspaceId, seesTemplate, status ?? null, rank, afterId, limit + 1],
    ),
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return c.json({
    items: page.map(dto),
    ...(rows.length > limit && last ? { nextCursor: `${last.read_only ? 1 : 0}:${last.id}` } : {}),
  });
});

cases.get("/:id", async (c) => {
  const actor = c.get("actor");
  const id = c.req.param("id");
  if (!isUuid(id)) throw notFound();
  const row = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    findCase(db, actor.workspaceId, actor.kind === "guest", id),
  );
  if (!row) throw notFound();
  return c.json(dto(row));
});

// The one write in P1: a title edit, so the isolation matrix tests a real write path.
// Status moves and the rest of the case workflow belong to P2.
cases.patch("/:id", requireCapability("cases:edit"), async (c) => {
  const actor = c.get("actor");
  const id = c.req.param("id");
  if (!isUuid(id)) throw notFound();
  const { title, version } = await readStrictJson(c, ["title", "version"]);
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > MAX_TITLE ||
    title.includes("\u0000")
  ) {
    throw invalidRequest("Title must be 1 to 200 characters");
  }
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > MAX_VERSION
  ) {
    throw invalidRequest("Version is required");
  }
  const row = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, async (db) => {
    const before = await findCase(db, actor.workspaceId, actor.kind === "guest", id);
    if (!before) throw notFound();
    if (before.read_only) throw forbidden();
    const updated = await db.query(
      `UPDATE app.cases SET title = $3, version = version + 1
        WHERE workspace_id = $1 AND id = $2 AND version = $4 RETURNING id`,
      [actor.workspaceId, id, title.trim(), version],
    );
    if (updated.rowCount === 0) {
      throw new ApiError(409, "stale_version", "Someone changed this case. Reload and try again.");
    }
    const after = await findCase(db, actor.workspaceId, false, id);
    await db.query(
      `INSERT INTO app.audit_events
         (workspace_id, actor_type, actor_id, action, target, before_hash, after_hash, request_id)
       VALUES ($1, $2, $3, 'case.updated', $4, $5, $6, $7)`,
      [
        actor.workspaceId,
        actor.kind === "owner" ? "owner" : "demo_session",
        actor.kind === "owner" ? actor.userId : actor.sessionId,
        id,
        await hashHex(dto(before)),
        await hashHex(dto(after)),
        c.get("requestId"),
      ],
    );
    return after;
  });
  return c.json(dto(row));
});
