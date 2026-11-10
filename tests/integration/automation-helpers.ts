import type { Bindings } from "../../backend/src/env";
import { dispatchDue } from "../../backend/src/jobs/dispatch";
import {
  baseEnv,
  call,
  connect,
  type Guest,
  idempotencyKey,
  mintOwnerToken,
  ownerEnv,
} from "./harness";
import type { SheetsDouble } from "./sheets-double";

// Fixed seed IDs, scripts/lib/template-data.mjs.
export const OWNER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const OWNER_CUSTOMER_ID = "00000000-0000-4000-8000-000000000003";
export const OWNER_RULE_ID = "00000000-0000-4000-8000-000000000006";

export const envWith = (extra: Partial<Bindings> = {}): Bindings =>
  ({ ...baseEnv(), ...ownerEnv, ...extra }) as Bindings;

export const ownerCall = async (
  path: string,
  options: { method?: string; body?: unknown; dbl?: SheetsDouble; key?: boolean } = {},
) =>
  call(path, {
    ...(options.method ? { method: options.method } : {}),
    ...(options.body !== undefined ? { body: options.body } : {}),
    env: { ...ownerEnv, ...(options.dbl?.env ?? {}) },
    headers: {
      "cf-access-jwt-assertion": await mintOwnerToken(),
      ...(options.key ? idempotencyKey() : {}),
    },
  });

export const dispatch = (opts: { workspaceId?: string; max?: number } = {}, dbl?: SheetsDouble) =>
  dispatchDue(envWith(dbl?.env), opts);

// Drains a workspace: repeated bounded passes until nothing is due.
export async function drain(workspaceId: string, dbl?: SheetsDouble) {
  const all = [];
  for (let i = 0; i < 20; i++) {
    const out = await dispatch({ workspaceId, max: 10 }, dbl);
    if (!out.length) break;
    all.push(...out);
  }
  return all;
}

let n = 0;
// Puts a committed event straight into a workspace's outbox, as the business transaction would.
export async function insertEvent(
  workspaceId: string,
  type: string,
  data: Record<string, unknown>,
  mode: "demo" | "owner" = "demo",
) {
  const id = crypto.randomUUID();
  const ref = String(data.caseRef ?? data.findingRef ?? data.provider ?? "REF");
  const payload = {
    id,
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    workspaceMode: mode,
    requestId: "test",
    data,
  };
  const mig = await connect("opsbridge_migrator");
  await mig.query(
    `INSERT INTO app.outbox (workspace_id, id, event_type, payload_ref, payload, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [workspaceId, id, type, ref.slice(0, 32), JSON.stringify(payload), `test:${id}:${n++}`],
  );
  await mig.end();
  return id;
}

export const approvedEvent = (queue = "Field Services") => ({
  caseRef: `CASE-${Math.floor(Math.random() * 1e8)
    .toString(16)
    .toUpperCase()
    .padStart(8, "0")}`,
  decision: "approved",
  queue,
});

export async function outboxRow(workspaceId: string, id: string) {
  const mig = await connect("opsbridge_migrator");
  const { rows } = await mig.query("SELECT * FROM app.outbox WHERE workspace_id = $1 AND id = $2", [
    workspaceId,
    id,
  ]);
  await mig.end();
  return rows[0];
}

export async function attemptsOf(workspaceId: string, id: string) {
  const mig = await connect("opsbridge_migrator");
  const { rows } = await mig.query(
    `SELECT attempt, outcome, code, evidence_ref, sink, next_attempt_at FROM app.outbox_attempts
      WHERE workspace_id = $1 AND outbox_id = $2 ORDER BY finished_at, id`,
    [workspaceId, id],
  );
  await mig.end();
  return rows;
}

export async function effectsOf(workspaceId: string, id: string) {
  const mig = await connect("opsbridge_migrator");
  const { rows } = await mig.query(
    "SELECT rule_id, rule_version, action, sink FROM app.automation_effects WHERE workspace_id = $1 AND outbox_id = $2",
    [workspaceId, id],
  );
  await mig.end();
  return rows;
}

// Test-only clock moves, done as the migrator: skip a backoff, or let a lease run out.
export async function makeDue(workspaceId: string, id: string) {
  const mig = await connect("opsbridge_migrator");
  await mig.query(
    "UPDATE app.outbox SET next_attempt_at = now() WHERE workspace_id = $1 AND id = $2",
    [workspaceId, id],
  );
  await mig.end();
}

export async function expireLease(workspaceId: string, id: string) {
  const mig = await connect("opsbridge_migrator");
  await mig.query(
    "UPDATE app.outbox SET lease_expires_at = now() - interval '1 second' WHERE workspace_id = $1 AND id = $2 AND dispatch_state = 'processing'",
    [workspaceId, id],
  );
  await mig.end();
}

// An owner case waiting in Ready with its pending approval, the state P2's commands leave it in.
export async function ownerReadyCase(queue = "Field Services") {
  const mig = await connect("opsbridge_migrator");
  const c = await mig.query(
    `INSERT INTO app.cases (workspace_id, customer_id, title, case_type, status, queue)
     VALUES ($1, $2, 'Owner automation case', 'Onboarding', 'Ready', $3) RETURNING id, version`,
    [OWNER_WORKSPACE_ID, OWNER_CUSTOMER_ID, queue],
  );
  const a = await mig.query(
    `INSERT INTO app.approvals (workspace_id, case_id, proposed_action, requested_by)
     VALUES ($1, $2, 'approve_case', 'owner') RETURNING id`,
    [OWNER_WORKSPACE_ID, c.rows[0].id],
  );
  await mig.end();
  return {
    caseId: c.rows[0].id as string,
    version: c.rows[0].version as number,
    approvalId: a.rows[0].id as string,
  };
}

export const guestDecide = (
  g: Guest,
  approvalId: string,
  caseVersion: number,
  extra: Partial<Bindings> = {},
  key = idempotencyKey(),
) =>
  call(`/api/v1/approvals/${approvalId}/decision`, {
    method: "POST",
    cookie: g.cookie,
    headers: key,
    env: extra,
    body: { decision: "approve", caseVersion },
  });

export async function eventsOf(workspaceId: string, type?: string) {
  const mig = await connect("opsbridge_migrator");
  const { rows } = await mig.query(
    `SELECT * FROM app.outbox WHERE workspace_id = $1 AND ($2::text IS NULL OR event_type = $2)
      ORDER BY created_at, id`,
    [workspaceId, type ?? null],
  );
  await mig.end();
  return rows;
}

export async function setPaused(paused: boolean) {
  const mig = await connect("opsbridge_migrator");
  await mig.query("UPDATE app.automation_control SET dispatch_paused = $1", [paused]);
  await mig.end();
}
