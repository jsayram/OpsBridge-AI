import type { Actor } from "../auth/actor";
import { hashHex } from "../auth/tokens";
import type { Db } from "../db";
import { type EventData, eventEnvelope, type WorkspaceMode } from "../domain/events";
import { ApiError } from "../http/errors";

// Everything a command needs to record who did what. Built only from the server-side actor.
export type CommandContext = {
  db: Db;
  workspaceId: string;
  workspaceMode: WorkspaceMode;
  actorType: "demo_session" | "owner";
  actorId: string;
  actorRole: "viewer" | "analyst" | "manager" | "owner";
  requestId: string;
};

export const commandContext = (db: Db, actor: Actor, requestId: string): CommandContext =>
  actor.kind === "owner"
    ? {
        db,
        workspaceId: actor.workspaceId,
        workspaceMode: "owner",
        actorType: "owner",
        actorId: actor.userId,
        actorRole: "owner",
        requestId,
      }
    : {
        db,
        workspaceId: actor.workspaceId,
        workspaceMode: "demo",
        actorType: "demo_session",
        actorId: actor.sessionId,
        actorRole: actor.demoRole,
        requestId,
      };

export async function writeAudit(
  ctx: CommandContext,
  action: string,
  target: string,
  change: { before?: unknown; after?: unknown; summary?: string } = {},
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO app.audit_events (workspace_id, actor_type, actor_id, actor_role, action, target,
                                   before_hash, after_hash, summary, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      ctx.workspaceId,
      ctx.actorType,
      ctx.actorId,
      ctx.actorRole,
      action,
      target,
      change.before === undefined ? null : await hashHex(change.before),
      change.after === undefined ? null : await hashHex(change.after),
      change.summary ?? null,
      ctx.requestId,
    ],
  );
}

// Runs inside the business transaction. A duplicate key fails the whole command, which is the
// point: one durable event per business intent. Nothing is sent from here; that is P4.
export async function emitEvent<T extends keyof EventData>(
  ctx: CommandContext,
  type: T,
  idempotencyKey: string,
  ref: string,
  data: EventData[T],
): Promise<void> {
  const id = crypto.randomUUID();
  const envelope = eventEnvelope({
    id,
    type,
    occurredAt: new Date().toISOString(),
    workspaceMode: ctx.workspaceMode,
    requestId: ctx.requestId,
    data,
  });
  await ctx.db.query(
    `INSERT INTO app.outbox (workspace_id, id, event_type, payload_ref, payload, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ctx.workspaceId, id, type, ref, JSON.stringify(envelope), idempotencyKey],
  );
}

export type StoredResponse = { status: number; body: unknown; replayed: boolean };

// PRD 7: written in the command's own transaction, so a failed command leaves no key and a
// retry runs for real. A concurrent duplicate waits on the unique key, then sees the result.
export async function idempotent(
  ctx: CommandContext,
  key: string,
  requestHash: string,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<StoredResponse> {
  const claim = await ctx.db.query(
    `INSERT INTO app.idempotency_keys (workspace_id, key, request_hash)
     VALUES ($1, $2, decode($3, 'hex')) ON CONFLICT DO NOTHING RETURNING key`,
    [ctx.workspaceId, key, requestHash],
  );
  if (claim.rowCount === 0) {
    const { rows } = await ctx.db.query(
      `SELECT encode(request_hash, 'hex') AS hash, response_status, response_body
         FROM app.idempotency_keys WHERE workspace_id = $1 AND key = $2`,
      [ctx.workspaceId, key],
    );
    if (rows[0]?.hash !== requestHash) {
      throw new ApiError(
        409,
        "idempotency_conflict",
        "That idempotency key was used for a different request.",
      );
    }
    return { status: rows[0].response_status, body: rows[0].response_body, replayed: true };
  }
  const result = await run();
  await ctx.db.query(
    `UPDATE app.idempotency_keys SET response_status = $3, response_body = $4
      WHERE workspace_id = $1 AND key = $2`,
    [ctx.workspaceId, key, result.status, JSON.stringify(result.body)],
  );
  return { ...result, replayed: false };
}
