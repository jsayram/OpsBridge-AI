import { type Context, Hono } from "hono";
import { requireActor, requireCapability } from "../auth/actor";
import { hashHex } from "../auth/tokens";
import { withWorkspace } from "../db";
import { CASE_STATUSES } from "../domain/caseStatus";
import { CASE_TYPES, QUEUES } from "../domain/caseVocabulary";
import { CHECKLIST_STATES } from "../domain/checklist";
import type { AppEnv } from "../env";
import { invalidRequest, notFound } from "../http/errors";
import {
  canonicalId,
  isUuid,
  isVersion,
  optionalText,
  readStrictJson,
  requireDate,
  requireIdempotencyKey,
  requireOneOf,
  requireText,
  requireVersion,
} from "../http/validate";
import {
  createCase,
  handOffCase,
  reopenCase,
  updateCase,
  updateChecklistItem,
} from "../repo/caseCommands";
import { type CaseQuery, caseActivity, caseDetail, findCase, listCases } from "../repo/cases";
import { commandContext, idempotent } from "../repo/records";

const MAX_TITLE = 200;
const MAX_REASON = 500;
const CURSOR = /^([01])_(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f-]{36})$/;

// A real calendar moment: the regex alone lets month 13 through to the database.
const isRealInstant = (at: string) => {
  const parsed = new Date(`${at.slice(0, 23)}Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 23) === at.slice(0, 23);
};

const pageLimit = (c: Context) => {
  const limit = Number(c.req.query("limit") ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidRequest("Bad limit");
  return limit;
};

function caseQuery(c: Context<AppEnv>): CaseQuery {
  const actor = c.get("actor");
  const q: CaseQuery = {
    workspaceId: actor.workspaceId,
    seesTemplate: actor.kind === "guest",
    limit: pageLimit(c),
  };
  const { status, queue, caseType, assignee, overdue, q: search, cursor } = c.req.query();
  if (status !== undefined) q.status = requireOneOf(status, CASE_STATUSES, "status");
  if (queue !== undefined) q.queue = requireOneOf(queue, QUEUES, "queue");
  if (caseType !== undefined) q.caseType = requireOneOf(caseType, CASE_TYPES, "case type");
  if (assignee === "unassigned") q.unassigned = true;
  else if (assignee !== undefined) {
    if (!isUuid(assignee)) throw invalidRequest("Bad assignee");
    q.assigneeId = assignee;
  }
  if (overdue !== undefined) {
    if (overdue !== "true") throw invalidRequest("Bad overdue filter");
    q.overdue = true;
  }
  if (search !== undefined) q.search = requireText(search, "Search", 100);
  if (cursor !== undefined) {
    const m = CURSOR.exec(cursor);
    if (!m || !isUuid(m[3] as string) || !isRealInstant(m[2] as string)) {
      throw invalidRequest("Bad cursor");
    }
    q.cursor = { rank: m[1] === "1" ? 1 : 0, at: m[2] as string, id: m[3] as string };
  }
  return q;
}

export const cases = new Hono<AppEnv>();

cases.use("*", requireActor, requireCapability("cases:read"));

cases.get("/", async (c) => {
  const query = caseQuery(c);
  return c.json(
    await withWorkspace(c.env.HYPERDRIVE, query.workspaceId, (db) => listCases(db, query)),
  );
});

cases.post("/", requireCapability("cases:edit"), async (c) => {
  const actor = c.get("actor");
  const key = requireIdempotencyKey(c);
  const body = await readStrictJson(c, [
    "title",
    "customerId",
    "caseType",
    "queue",
    "dueAt",
    "draft",
  ]);
  const customerId = body.customerId;
  if (typeof customerId !== "string" || !isUuid(customerId)) throw invalidRequest("Bad customer");
  if (body.draft !== undefined && typeof body.draft !== "boolean") {
    throw invalidRequest("Bad draft flag");
  }
  const input = {
    title: requireText(body.title, "Title", MAX_TITLE),
    customerId,
    caseType: requireOneOf(body.caseType, CASE_TYPES, "case type"),
    queue: body.queue === undefined ? QUEUES[0] : requireOneOf(body.queue, QUEUES, "queue"),
    dueAt: body.dueAt === undefined ? null : requireDate(body.dueAt, "due date"),
    draft: body.draft === true,
  };
  const hash = await hashHex({ route: "POST /cases", input });
  const out = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) => {
    const ctx = commandContext(db, actor, c.get("requestId"));
    return idempotent(ctx, key, hash, async () => ({
      status: 201,
      body: await createCase(ctx, input),
    }));
  });
  if (out.replayed) c.header("Idempotency-Replayed", "true");
  return c.json(out.body as object, out.status as 201);
});

cases.get("/:id", async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const detail = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, async (db) => {
    const row = await findCase(db, actor.workspaceId, actor.kind === "guest", id);
    return row ? caseDetail(db, row, actor.workspaceId) : null;
  });
  if (!detail) throw notFound();
  return c.json(detail);
});

cases.get("/:id/activity", async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const limit = pageLimit(c);
  const cursor = c.req.query("cursor");
  if (cursor !== undefined && !/^\d{1,18}$/.test(cursor)) throw invalidRequest("Bad cursor");
  const page = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, async (db) => {
    const row = await findCase(db, actor.workspaceId, actor.kind === "guest", id);
    if (!row) return null;
    // Audit rows are private to a workspace, so shared sample cases show no history.
    return row.read_only ? { items: [] } : caseActivity(db, actor.workspaceId, id, limit, cursor);
  });
  if (!page) throw notFound();
  return c.json(page);
});

// PATCH covers details and status. Approved and leaving Closed each have their own command.
cases.patch("/:id", requireCapability("cases:edit"), async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const body = await readStrictJson(c, ["version", "title", "dueAt", "status", "reason"]);
  const version = requireVersion(body.version);
  if (body.title === undefined && body.dueAt === undefined && body.status === undefined) {
    throw invalidRequest("Nothing to change");
  }
  if (body.reason !== undefined && body.status === undefined) {
    throw invalidRequest("A reason goes with a status change");
  }
  const reason = optionalText(body.reason, "Reason", MAX_REASON);
  const patch = {
    version,
    ...(body.title !== undefined ? { title: requireText(body.title, "Title", MAX_TITLE) } : {}),
    ...(body.dueAt !== undefined
      ? { dueAt: body.dueAt === null ? null : requireDate(body.dueAt, "due date") }
      : {}),
    ...(body.status !== undefined
      ? { status: requireOneOf(body.status, CASE_STATUSES, "status") }
      : {}),
    ...(reason ? { reason } : {}),
  };
  const row = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    updateCase(commandContext(db, actor, c.get("requestId")), actor.kind === "guest", id, patch),
  );
  return c.json(row);
});

cases.post("/:id/reopen", requireCapability("cases:reopen"), async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const body = await readStrictJson(c, ["reason", "version"]);
  const version = requireVersion(body.version);
  const reason = requireText(body.reason, "Reason", MAX_REASON);
  const row = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    reopenCase(
      commandContext(db, actor, c.get("requestId")),
      actor.kind === "guest",
      id,
      version,
      reason,
    ),
  );
  return c.json(row);
});

cases.post("/:id/handoffs", requireCapability("cases:handoff"), async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const body = await readStrictJson(c, [
    "toAssigneeId",
    "toQueue",
    "reason",
    "dueAt",
    "expectedCaseVersion",
    "inventoryItemId",
  ]);
  if ((body.toAssigneeId === undefined) === (body.toQueue === undefined)) {
    throw invalidRequest("Name either a person or a queue");
  }
  if (!isVersion(body.expectedCaseVersion)) throw invalidRequest("Version is required");
  if (
    body.toAssigneeId !== undefined &&
    (typeof body.toAssigneeId !== "string" || !isUuid(body.toAssigneeId))
  ) {
    throw invalidRequest("Bad assignee");
  }
  const item = body.inventoryItemId;
  if (item !== undefined && (typeof item !== "string" || !isUuid(item))) {
    throw invalidRequest("Bad inventory item");
  }
  const input = {
    ...(item !== undefined ? { inventoryItemId: item as string } : {}),
    ...(body.toAssigneeId !== undefined ? { toAssigneeId: body.toAssigneeId as string } : {}),
    ...(body.toQueue !== undefined ? { toQueue: requireOneOf(body.toQueue, QUEUES, "queue") } : {}),
    reason: requireText(body.reason, "Reason", MAX_REASON),
    ...(body.dueAt !== undefined ? { dueAt: requireDate(body.dueAt, "due date") } : {}),
    expectedCaseVersion: body.expectedCaseVersion,
  };
  const row = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    handOffCase(commandContext(db, actor, c.get("requestId")), actor.kind === "guest", id, input),
  );
  return c.json(row, 201);
});

cases.patch("/:id/checklist/:itemId", requireCapability("cases:edit"), async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const itemId = canonicalId(c.req.param("itemId"));
  const body = await readStrictJson(c, ["state", "version", "evidenceRef"]);
  const evidenceRef = optionalText(body.evidenceRef, "Evidence reference", 200);
  const input = {
    state: requireOneOf(body.state, CHECKLIST_STATES, "state"),
    version: requireVersion(body.version),
    ...(evidenceRef ? { evidenceRef } : {}),
  };
  const row = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    updateChecklistItem(
      commandContext(db, actor, c.get("requestId")),
      actor.kind === "guest",
      id,
      itemId,
      input,
    ),
  );
  return c.json(row);
});
