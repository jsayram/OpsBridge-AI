import { Hono } from "hono";
import { requireActor, requireCapability } from "../auth/actor";
import { hashHex } from "../auth/tokens";
import { withWorkspace } from "../db";
import type { AppEnv } from "../env";
import { notFound } from "../http/errors";
import {
  isUuid,
  optionalText,
  readStrictJson,
  requireIdempotencyKey,
  requireOneOf,
  requireVersion,
} from "../http/validate";
import { decideApproval } from "../repo/caseCommands";
import { commandContext, idempotent } from "../repo/records";

export const approvals = new Hono<AppEnv>();

approvals.use("*", requireActor, requireCapability("approvals:decide"));

approvals.post("/:id/decision", async (c) => {
  const actor = c.get("actor");
  const id = c.req.param("id");
  if (!isUuid(id)) throw notFound();
  const key = requireIdempotencyKey(c);
  const body = await readStrictJson(c, ["decision", "caseVersion", "reason"]);
  const reason = optionalText(body.reason, "Reason", 500);
  const input = {
    decision: requireOneOf(body.decision, ["approve", "reject"] as const, "decision"),
    caseVersion: requireVersion(body.caseVersion),
    ...(reason ? { reason } : {}),
  };
  const hash = await hashHex({ route: "POST /approvals/decision", id, input });
  const out = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) => {
    const ctx = commandContext(db, actor, c.get("requestId"));
    return idempotent(ctx, key, hash, async () => ({
      status: 200,
      body: await decideApproval(ctx, id, input),
    }));
  });
  if (out.replayed) c.header("Idempotency-Replayed", "true");
  return c.json(out.body as object, 200);
});
