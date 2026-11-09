// P4.2: the outbox dispatcher. Runs right after a command commits (ctx.waitUntil) and from the
// 30-minute cron sweep. Each event: claim with a 130-second lease in one statement, read the
// workspace's rules in one short transaction, deliver with no transaction open, then finish in one
// statement that presents the lease token. A crash anywhere leaves the event claimable again when
// the lease runs out, and the sink's own check (sheet event-ID column, effects ledger key) turns
// the repeat into a no-op.
import type { Client } from "../db";
import { inWorkspaceTx, pgCode, withClient } from "../db";
import type { EventType } from "../domain/events";
import { isEventType, matchingRules, type Rule } from "../domain/rules";
import type { Bindings } from "../env";
import { log } from "../http/log";
import {
  type DeliverableEvent,
  type DeliveryResult,
  type EventSink,
  sheetConfig,
  sheetSink,
  simulatedSink,
} from "../integrations/sinks";

// Keeps a cron tick inside Workers Free CPU (INTEGRATION-CONTRACTS.md, Bounds).
export const MAX_PER_TICK = 3;

export type Claim = {
  workspace_id: string;
  id: string;
  payload: DeliverableEvent;
  attempts: number;
  lease_token: string;
  workspace_mode: "owner" | "demo";
};

export type Outcome = { id: string; state: string; sink: EventSink["mode"]; matched: number };

export async function claimDue(db: Client, max: number, workspaceId?: string): Promise<Claim[]> {
  const { rows } = await db.query("SELECT * FROM app.claim_due_outbox($1, $2)", [
    max,
    workspaceId ?? null,
  ]);
  return rows as Claim[];
}

async function rulesFor(db: Client, workspaceId: string, type: EventType): Promise<Rule[]> {
  const { rows } = await inWorkspaceTx(db, workspaceId, () =>
    db.query(
      `SELECT id, name, trigger_event, condition, action, enabled, version FROM app.workflow_rules
        WHERE workspace_id = $1 AND trigger_event = $2 AND enabled ORDER BY name, id`,
      [workspaceId, type],
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    trigger: r.trigger_event,
    condition: r.condition,
    action: r.action,
    enabled: r.enabled,
    version: r.version,
  }));
}

type Planned = {
  sink: EventSink;
  effects: { ruleId: string; ruleVersion: number; action: string; sink: string }[];
};

// The sink comes from the workspace mode in the database, never from the request. A demo
// workspace can only reach the simulated sink, whatever its rules say (P4-D).
export async function plan(db: Client, env: Bindings, claim: Claim): Promise<Planned> {
  const type = claim.payload.type;
  const matched = isEventType(type)
    ? matchingRules(await rulesFor(db, claim.workspace_id, type), type, claim.payload.data)
    : [];
  const live =
    claim.workspace_mode === "owner" && matched.some((r) => r.action === "sheet_append")
      ? sheetConfig(env)
      : null;
  return {
    sink: live ? sheetSink(live) : simulatedSink(matched.length),
    effects: matched.map((r) => ({
      ruleId: r.id,
      ruleVersion: r.version,
      action: r.action,
      sink: live && r.action === "sheet_append" ? "sheet_bridge" : "simulated",
    })),
  };
}

export async function finish(
  db: Client,
  claim: Claim,
  planned: Planned,
  result: DeliveryResult,
): Promise<string> {
  const outcome = result.kind;
  const evidence = "evidenceRef" in result ? result.evidenceRef : null;
  const code = "code" in result ? result.code : null;
  const retryAfter = result.kind === "retryable" ? (result.retryAfterSeconds ?? null) : null;
  const { rows } = await db.query(
    "SELECT app.finish_outbox($1, $2, $3, $4, $5, $6, $7, $8, $9) AS state",
    [
      claim.workspace_id,
      claim.id,
      claim.lease_token,
      outcome,
      evidence,
      code,
      retryAfter,
      planned.sink.mode,
      JSON.stringify(planned.effects),
    ],
  );
  return rows[0].state;
}

export async function deliver(planned: Planned, claim: Claim): Promise<DeliveryResult> {
  try {
    return await planned.sink.deliver(claim.payload);
  } catch {
    return { kind: "retryable", code: "sink_error" };
  }
}

export async function processClaim(db: Client, env: Bindings, claim: Claim): Promise<Outcome> {
  const planned = await plan(db, env, claim);
  const result = await deliver(planned, claim);
  const state = await finish(db, claim, planned, result);
  log({
    level: state === "dead_letter" ? "error" : "info",
    event: "outbox_dispatch",
    outcome: state,
    sink: planned.sink.mode,
    attempt: claim.attempts,
    ...("code" in result ? { code: result.code } : {}),
  });
  return { id: claim.id, state, sink: planned.sink.mode, matched: planned.effects.length };
}

// One bounded pass. Errors stay inside: an event left processing is reclaimed after its lease.
export async function dispatchDue(
  env: Bindings,
  options: { workspaceId?: string; max?: number } = {},
): Promise<Outcome[]> {
  try {
    return await withClient(env.HYPERDRIVE, async (db) => {
      const out: Outcome[] = [];
      for (const claim of await claimDue(db, options.max ?? MAX_PER_TICK, options.workspaceId)) {
        try {
          out.push(await processClaim(db, env, claim));
        } catch (e) {
          log({ level: "error", event: "outbox_dispatch_failed", dbCode: pgCode(e) ?? "unknown" });
        }
      }
      return out;
    });
  } catch (e) {
    log({ level: "error", event: "outbox_claim_failed", dbCode: pgCode(e) ?? "unknown" });
    return [];
  }
}
