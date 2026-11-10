import { Hono } from "hono";
import { requireActor, requireCapability } from "../auth/actor";
import { hashHex } from "../auth/tokens";
import { withWorkspace } from "../db";
import { FINDING_STATUSES } from "../domain/findingStatus";
import { GLOSSARY, RULES } from "../domain/glossary";
import { NORMALIZATION_VERSION } from "../domain/reconcile";
import type { AppEnv } from "../env";
import { invalidRequest, notFound } from "../http/errors";
import {
  canonicalId,
  isUuid,
  optionalText,
  readStrictJson,
  requireDate,
  requireIdempotencyKey,
  requireOneOf,
  requireVersion,
} from "../http/validate";
import {
  advanceFinding,
  customerSources,
  findFinding,
  findingDto,
  listFindings,
  resolveFinding,
} from "../repo/reconciliation";
import { commandContext, idempotent } from "../repo/records";

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)_([0-9a-f-]{36})$/;

export const reconciliation = new Hono<AppEnv>();

reconciliation.use("*", requireActor, requireCapability("reconciliation:read"));

reconciliation.get("/", async (c) => {
  const actor = c.get("actor");
  const limit = Number(c.req.query("limit") ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidRequest("Bad limit");
  const status = c.req.query("status");
  const cursor = c.req.query("cursor");
  const match = cursor ? cursor.match(CURSOR) : null;
  if (
    cursor &&
    (!match || Number.isNaN(Date.parse(match[1] as string)) || !isUuid(match[2] as string))
  ) {
    throw invalidRequest("Bad cursor");
  }
  const page = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    listFindings(db, {
      workspaceId: actor.workspaceId,
      shared: c.req.query("scope") === "shared" && actor.kind === "guest",
      limit,
      ...(status ? { status: requireOneOf(status, FINDING_STATUSES, "status") } : {}),
      ...(match ? { before: { at: match[1] as string, id: match[2] as string } } : {}),
    }),
  );
  return c.json(page);
});

reconciliation.get("/definitions", (c) =>
  c.json({ terms: GLOSSARY, rules: RULES, normalization: NORMALIZATION_VERSION }),
);

reconciliation.get("/customers/:id", async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const body = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    customerSources(db, actor.workspaceId, id),
  );
  return c.json(body);
});

reconciliation.get("/:id", async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const row = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    findFinding(db, actor.workspaceId, actor.kind === "guest", id),
  );
  if (!row) throw notFound();
  return c.json(findingDto(row));
});

reconciliation.post("/:id/advance", requireCapability("reconciliation:advance"), async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const body = await readStrictJson(c, ["to", "version", "proposal"]);
  const proposal = optionalText(body.proposal, "Proposal", 500);
  const input = {
    to: requireOneOf(body.to, ["Open", "Investigating", "Proposed"] as const, "status"),
    version: requireVersion(body.version),
    ...(proposal ? { proposal } : {}),
  };
  const out = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    advanceFinding(
      commandContext(db, actor, c.get("requestId")),
      actor.kind === "guest",
      id,
      input,
    ),
  );
  return c.json(out);
});

reconciliation.post("/:id/resolve", requireCapability("reconciliation:resolve"), async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const key = requireIdempotencyKey(c);
  const body = await readStrictJson(c, [
    "decision",
    "version",
    "reason",
    "deferUntil",
    "targetCustomerId",
  ]);
  const reason = optionalText(body.reason, "Reason", 500);
  const target = body.targetCustomerId;
  if (target !== undefined && (typeof target !== "string" || !isUuid(target))) {
    throw invalidRequest("Bad customer");
  }
  const input = {
    decision: requireOneOf(body.decision, ["approve", "reject", "defer"] as const, "decision"),
    version: requireVersion(body.version),
    ...(reason ? { reason } : {}),
    ...(body.deferUntil !== undefined ? { deferUntil: requireDate(body.deferUntil, "date") } : {}),
    ...(target !== undefined ? { targetCustomerId: (target as string).toLowerCase() } : {}),
  };
  const hash = await hashHex({ route: "POST /reconciliation/resolve", id, input });
  const out = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) => {
    const ctx = commandContext(db, actor, c.get("requestId"));
    return idempotent(ctx, key, hash, async () => ({
      status: 200,
      body: await resolveFinding(ctx, actor.kind === "guest", id, input),
    }));
  });
  if (out.replayed) c.header("Idempotency-Replayed", "true");
  return c.json(out.body as object, 200);
});
