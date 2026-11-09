import { Hono } from "hono";
import { requireActor, requireCapability } from "../auth/actor";
import { hashHex } from "../auth/tokens";
import { withWorkspace } from "../db";
import { QUEUES } from "../domain/caseVocabulary";
import { isEventType, matchingRules, parseSampleData, RuleError } from "../domain/rules";
import type { AppEnv } from "../env";
import { invalidRequest } from "../http/errors";
import {
  canonicalId,
  isUuid,
  readStrictJson,
  requireIdempotencyKey,
  requireOneOf,
  requireVersion,
} from "../http/validate";
import { sheetConfig } from "../integrations/sinks";
import {
  automationStatus,
  findRun,
  listRules,
  listRuns,
  reuseRule,
  toRule,
  updateRule,
} from "../repo/automations";
import { commandContext, idempotent } from "../repo/records";

export const automations = new Hono<AppEnv>();

automations.use("*", requireActor, requireCapability("automations:read"));

const ruleInvalid = (e: unknown) => {
  if (e instanceof RuleError) {
    return invalidRequest(
      "Rules accept only listed fields and values. Addresses, links and code are refused.",
    );
  }
  return e;
};

automations.get("/rules", async (c) => {
  const actor = c.get("actor");
  const out = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, async (db) => ({
    items: await listRules(db, actor.workspaceId),
    status: await automationStatus(db),
  }));
  return c.json({
    ...out,
    // Where an owner rule would go. A demo workspace never reaches a live transport.
    transport:
      actor.kind === "owner" && sheetConfig(c.env) && !sheetConfig(c.env)?.double
        ? "Google Sheet bridge (owner test mode)"
        : "Simulated",
    teams: QUEUES,
  });
});

automations.patch("/rules/:id", requireCapability("automations:manage"), async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const body = await readStrictJson(c, ["version", "enabled", "condition"]);
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw invalidRequest("Bad enabled");
  }
  const input = {
    version: requireVersion(body.version),
    ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
    ...(body.condition !== undefined ? { condition: body.condition } : {}),
  };
  try {
    const rule = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
      updateRule(commandContext(db, actor, c.get("requestId")), id, input),
    );
    return c.json(rule);
  } catch (e) {
    throw ruleInvalid(e);
  }
});

automations.post("/rules/:id/reuse", requireCapability("automations:manage"), async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const key = requireIdempotencyKey(c);
  const body = await readStrictJson(c, ["queue"]);
  const queue = requireOneOf(body.queue, QUEUES, "team");
  const hash = await hashHex({ route: "POST /automations/rules/reuse", id, queue });
  const out = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) => {
    const ctx = commandContext(db, actor, c.get("requestId"));
    return idempotent(ctx, key, hash, async () => ({
      status: 201,
      body: await reuseRule(ctx, id, queue),
    }));
  });
  if (out.replayed) c.header("Idempotency-Replayed", "true");
  return c.json(out.body as object, 201);
});

// Read-only preview: which rules a sample event would match, and what would happen. Nothing is
// queued or sent.
automations.post("/simulate", async (c) => {
  const actor = c.get("actor");
  const body = await readStrictJson(c, ["type", "data"]);
  if (!isEventType(body.type)) throw invalidRequest("Bad event type");
  const type = body.type;
  let data: Record<string, string>;
  try {
    data = parseSampleData(type, body.data ?? {});
  } catch (e) {
    throw ruleInvalid(e);
  }
  const rules = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    listRules(db, actor.workspaceId),
  );
  const matched = matchingRules(rules.map(toRule), type, data);
  return c.json({
    type,
    data,
    matched: matched.map((r) => ({ id: r.id, name: r.name, action: r.action, version: r.version })),
    outcome: matched.length
      ? "Simulated: the effect is recorded here and nothing leaves the system."
      : "No enabled rule matches, so the event would be recorded with no effect.",
  });
});

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)_([0-9a-f-]{36})$/;

automations.get("/runs", async (c) => {
  const actor = c.get("actor");
  const limit = Number(c.req.query("limit") ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidRequest("Bad limit");
  const cursor = c.req.query("cursor");
  const match = cursor ? cursor.match(CURSOR) : null;
  if (
    cursor &&
    (!match || Number.isNaN(Date.parse(match[1] as string)) || !isUuid(match[2] as string))
  ) {
    throw invalidRequest("Bad cursor");
  }
  const page = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    listRuns(db, actor.workspaceId, {
      limit,
      ...(match ? { before: { at: match[1] as string, id: match[2] as string } } : {}),
    }),
  );
  return c.json(page);
});

automations.get("/runs/:id", async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const run = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    findRun(db, actor.workspaceId, id),
  );
  return c.json(run);
});
