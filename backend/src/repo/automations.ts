// P4.1 and P4.4: rule edits and reuse, run history and the owner's operator actions. Every write
// audits in the same transaction. Outbox rows change only through the definer functions in
// migration 0007; this file never updates the outbox table directly.
import type { Db } from "../db";
import { type DeliveryEvidence, type DispatchState, deliveryLabel } from "../domain/deliveryLabel";
import type { EventType } from "../domain/events";
import {
  type Condition,
  CONDITION_FIELDS,
  describeCondition,
  parseCondition,
  type Rule,
  type RuleAction,
} from "../domain/rules";
import { ApiError, notFound } from "../http/errors";
import { type CommandContext, writeAudit } from "./records";

// biome-ignore lint/suspicious/noExplicitAny: database rows, shaped by the DTOs below
type Row = Record<string, any>;

export const stale = () =>
  new ApiError(409, "stale_version", "Someone changed this rule. Reload and try again.");

export const ruleDto = (r: Row) => ({
  id: r.id as string,
  name: r.name as string,
  trigger: r.trigger_event as EventType,
  condition: r.condition as Condition,
  conditionText: describeCondition(r.condition),
  action: r.action as RuleAction,
  enabled: r.enabled as boolean,
  version: r.version as number,
  reusedFrom: (r.reused_from as string | null) ?? null,
  reusable: Object.hasOwn(CONDITION_FIELDS[r.trigger_event as EventType], "queue"),
  updatedAt: (r.updated_at as Date).toISOString(),
});

const RULE_COLUMNS =
  "id, name, trigger_event, condition, action, enabled, version, reused_from, updated_at";

export async function listRules(db: Db, workspaceId: string) {
  const { rows } = await db.query(
    `SELECT ${RULE_COLUMNS} FROM app.workflow_rules WHERE workspace_id = $1 ORDER BY name, id`,
    [workspaceId],
  );
  return rows.map(ruleDto);
}

export const toRule = (r: ReturnType<typeof ruleDto>): Rule => ({
  id: r.id,
  name: r.name,
  trigger: r.trigger,
  condition: r.condition,
  action: r.action,
  enabled: r.enabled,
  version: r.version,
});

async function lockRule(ctx: CommandContext, id: string): Promise<Row> {
  const { rows } = await ctx.db.query(
    `SELECT ${RULE_COLUMNS} FROM app.workflow_rules WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [ctx.workspaceId, id],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

// Enable, disable or narrow a rule. Any change is a new version, and dispatch records the version
// it used, so history says which definition produced each effect.
export async function updateRule(
  ctx: CommandContext,
  id: string,
  input: { version: number; enabled?: boolean; condition?: unknown },
) {
  const before = await lockRule(ctx, id);
  if (before.version !== input.version) throw stale();
  const condition =
    input.condition === undefined
      ? before.condition
      : parseCondition(before.trigger_event, input.condition);
  // A reused rule and its source each keep their team, or one-reuse-per-team stops meaning
  // anything and two rules could serve the same team (JOB-TEST-06).
  if (condition.queue !== before.condition.queue) {
    const linked =
      before.reused_from !== null ||
      (
        await ctx.db.query(
          "SELECT 1 FROM app.workflow_rules WHERE workspace_id = $1 AND reused_from = $2 LIMIT 1",
          [ctx.workspaceId, id],
        )
      ).rowCount !== 0;
    if (linked) {
      throw new ApiError(409, "team_locked", "A reused rule and its source keep their teams.");
    }
  }
  const enabled = input.enabled ?? before.enabled;
  const { rows } = await ctx.db.query(
    `UPDATE app.workflow_rules SET condition = $3, enabled = $4, version = version + 1,
            updated_at = now(), updated_by = $5
      WHERE workspace_id = $1 AND id = $2 AND version = $6 RETURNING ${RULE_COLUMNS}`,
    [ctx.workspaceId, id, JSON.stringify(condition), enabled, ctx.actorRole, input.version],
  );
  if (!rows[0]) throw stale();
  const after = ruleDto(rows[0]);
  await writeAudit(ctx, "rule.updated", id, {
    before: ruleDto(before),
    after,
    summary: `${after.enabled ? "enabled" : "disabled"}; ${after.conditionText}; v${after.version}`,
  });
  return after;
}

// JOB-TEST-06: the same typed rule, pointed at another team. Only the team changes: trigger,
// action and every other condition field are the source's, and the evaluator is shared code.
export async function reuseRule(ctx: CommandContext, sourceId: string, queue: string) {
  const source = await lockRule(ctx, sourceId);
  if (source.reused_from) {
    throw new ApiError(409, "reuse_of_reuse", "Reuse the original rule, not a copy of it.");
  }
  if (!Object.hasOwn(CONDITION_FIELDS[source.trigger_event as EventType], "queue")) {
    throw new ApiError(409, "not_team_scoped", "This rule's trigger has no team to change.");
  }
  if (source.condition.queue === queue) {
    throw new ApiError(409, "same_team", "This rule already serves that team.");
  }
  const condition = parseCondition(source.trigger_event, { ...source.condition, queue });
  const base = String(source.name).replace(/ for (Field Services|Seasonal Staffing)$/, "");
  const name = `${base} for ${queue}`.slice(0, 120);
  const { rows } = await ctx.db.query(
    `INSERT INTO app.workflow_rules (workspace_id, name, trigger_event, condition, action, enabled,
                                     reused_from, updated_by)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7)
     ON CONFLICT DO NOTHING RETURNING ${RULE_COLUMNS}`,
    [
      ctx.workspaceId,
      name,
      source.trigger_event,
      JSON.stringify(condition),
      source.action,
      sourceId,
      ctx.actorRole,
    ],
  );
  if (!rows[0]) {
    throw new ApiError(409, "already_reused", "This rule is already reused for that team.");
  }
  const created = ruleDto(rows[0]);
  await writeAudit(ctx, "rule.reused", created.id, {
    after: created,
    summary: `reused ${sourceId} for ${queue}`,
  });
  return created;
}

export const runDto = (r: Row) => ({
  id: r.id as string,
  type: r.event_type as EventType,
  ref: r.payload_ref as string,
  label: deliveryLabel(r.dispatch_state as DispatchState, r.delivery_evidence as DeliveryEvidence),
  dispatchState: r.dispatch_state as DispatchState,
  deliveryEvidence: r.delivery_evidence as DeliveryEvidence,
  evidenceRef: (r.evidence_ref as string | null) ?? null,
  attempts: r.attempts as number,
  lastErrorCode: (r.last_error_code as string | null) ?? null,
  nextAttemptAt:
    ["pending", "retry_scheduled"].includes(r.dispatch_state) && r.next_attempt_at
      ? (r.next_attempt_at as Date).toISOString()
      : null,
  effects:
    (r.effects as { ruleId: string; ruleVersion: number; action: string; sink: string }[]) ?? [],
  createdAt: (r.created_at as Date).toISOString(),
  finishedAt: r.finished_at ? (r.finished_at as Date).toISOString() : null,
  // PRD 9: Accepted means the provider took it. Only an owner's evidence makes it Confirmed.
  uncertain: r.dispatch_state === "accepted" && r.delivery_evidence === "provider_accepted",
});

const RUN_COLUMNS = `id, event_type, payload_ref, dispatch_state, delivery_evidence, evidence_ref,
  attempts, last_error_code, next_attempt_at, effects, created_at, finished_at`;

export async function listRuns(
  db: Db,
  workspaceId: string,
  opts: { limit: number; before?: { at: string; id: string } },
) {
  const { rows } = await db.query(
    `SELECT ${RUN_COLUMNS},
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cursor_at
       FROM app.outbox WHERE workspace_id = $1
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [workspaceId, opts.limit + 1, opts.before?.at ?? null, opts.before?.id ?? null],
  );
  const page = rows.slice(0, opts.limit);
  const last = page.at(-1);
  return {
    items: page.map(runDto),
    ...(rows.length > opts.limit && last ? { nextCursor: `${last.cursor_at}_${last.id}` } : {}),
  };
}

export async function findRun(db: Db, workspaceId: string, id: string) {
  const { rows } = await db.query(
    `SELECT ${RUN_COLUMNS} FROM app.outbox WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  if (!rows[0]) throw notFound();
  const attempts = await db.query(
    `SELECT attempt, outcome, code, evidence_ref, sink, next_attempt_at, finished_at
       FROM app.outbox_attempts WHERE workspace_id = $1 AND outbox_id = $2
      ORDER BY finished_at, id`,
    [workspaceId, id],
  );
  return {
    ...runDto(rows[0]),
    history: attempts.rows.map((a) => ({
      attempt: a.attempt as number,
      outcome: a.outcome as string,
      code: (a.code as string | null) ?? null,
      evidenceRef: (a.evidence_ref as string | null) ?? null,
      sink: (a.sink as string | null) ?? null,
      nextAttemptAt: a.next_attempt_at ? (a.next_attempt_at as Date).toISOString() : null,
      at: (a.finished_at as Date).toISOString(),
    })),
  };
}

export async function automationStatus(db: Db) {
  const { rows } = await db.query(
    "SELECT dispatch_paused, reason, changed_at FROM app.automation_control",
  );
  return {
    paused: rows[0]?.dispatch_paused === true,
    reason: (rows[0]?.reason as string | null) ?? null,
    changedAt: rows[0] ? (rows[0].changed_at as Date).toISOString() : null,
  };
}

// Owner operator actions. The function checks the workspace is the owner's; the caller's route is
// behind ownerGate as well.
export async function retryRun(ctx: CommandContext, id: string) {
  await findRun(ctx.db, ctx.workspaceId, id);
  const { rows } = await ctx.db.query("SELECT app.retry_dead_letter($1) AS ok", [id]);
  if (!rows[0].ok) {
    throw new ApiError(409, "not_dead_letter", "Only a failed run can be retried.");
  }
  await writeAudit(ctx, "automation.retried", id, { summary: "Dead Letter to Pending" });
  return findRun(ctx.db, ctx.workspaceId, id);
}

export async function confirmRun(ctx: CommandContext, id: string, evidenceRef: string) {
  await findRun(ctx.db, ctx.workspaceId, id);
  const { rows } = await ctx.db.query("SELECT app.confirm_outbox($1, $2) AS ok", [id, evidenceRef]);
  if (!rows[0].ok) {
    throw new ApiError(409, "not_accepted", "Only a run the provider accepted can be confirmed.");
  }
  await writeAudit(ctx, "automation.confirmed", id, { summary: `evidence ${evidenceRef}` });
  return findRun(ctx.db, ctx.workspaceId, id);
}

export async function setPause(ctx: CommandContext, paused: boolean, reason: string | null) {
  await ctx.db.query("SELECT app.set_automation_pause($1, $2, $3)", [
    paused,
    reason,
    ctx.actorId.slice(0, 120),
  ]);
  await writeAudit(ctx, paused ? "automation.paused" : "automation.resumed", "automation", {
    summary: reason ?? (paused ? "paused" : "resumed"),
  });
  return automationStatus(ctx.db);
}
