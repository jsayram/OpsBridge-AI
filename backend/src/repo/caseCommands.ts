import type { Db } from "../db";
import {
  type CaseCommand,
  type CaseRole,
  type CaseStatus,
  transitionCase,
} from "../domain/caseStatus";
import {
  checklistBlocks,
  checklistEditable,
  checklistFor,
  openRequiredCount,
} from "../domain/checklist";
import { caseRef } from "../domain/events";
import { ApiError, forbidden, invalidRequest, notFound } from "../http/errors";
import { caseDto, findCase, loadChecklist, lockCase } from "./cases";
import { type CommandContext, emitEvent, writeAudit } from "./records";

const stale = () =>
  new ApiError(409, "stale_version", "Someone changed this case. Reload and try again.");
const invalidTransition = (message = "That status change isn't allowed.") =>
  new ApiError(409, "invalid_transition", message);
const detailsLocked = () =>
  new ApiError(409, "case_locked", "Details are locked from Ready on. Return it to review first.");

// What a reviewer approved must stay what was approved, so details stop changing here.
const detailsFrozen = (status: unknown) =>
  status === "Ready" || status === "Approved" || status === "Closed";

export const workflowRole = (ctx: CommandContext): CaseRole | null => {
  if (ctx.actorRole === "owner" || ctx.actorRole === "manager") return "reviewer";
  return ctx.actorRole === "analyst" ? "analyst" : null;
};

type Row = Record<string, unknown>;

// Loads, locks and re-reads, so version and status checks use values no one can change until
// this transaction ends. Template rows stop here: visible, never writable.
async function lockedCase(ctx: CommandContext, seesTemplate: boolean, id: string): Promise<Row> {
  const seen = await findCase(ctx.db, ctx.workspaceId, seesTemplate, id);
  if (!seen) throw notFound();
  if (seen.read_only) throw forbidden();
  if (!(await lockCase(ctx.db, ctx.workspaceId, id))) throw notFound();
  return findCase(ctx.db, ctx.workspaceId, false, id) as Promise<Row>;
}

function checkTransition(
  ctx: CommandContext,
  from: CaseStatus,
  to: CaseStatus,
  command: CaseCommand,
  reason?: string,
) {
  const role = workflowRole(ctx);
  if (!role) throw forbidden();
  const result = transitionCase(from, to, role, command, reason);
  if (result.ok) return;
  switch (result.code) {
    case "forbidden_role":
      throw new ApiError(403, "forbidden", "A reviewer has to make this change.");
    case "reason_required":
      throw invalidRequest("A reason is required for this change");
    case "wrong_command":
      throw invalidTransition(
        to === "Approved"
          ? "A case reaches Approved only through an approval decision."
          : "A closed case reopens only through the reopen action.",
      );
    default:
      throw invalidTransition();
  }
}

async function checkChecklistGate(ctx: CommandContext, id: string, to: CaseStatus) {
  const items = await loadChecklist(ctx.db, ctx.workspaceId, id);
  if (checklistBlocks(to, items)) {
    throw new ApiError(
      409,
      "checklist_incomplete",
      to === "Ready"
        ? "Finish or clear every required checklist item first."
        : "Answer or flag every required checklist item first.",
    );
  }
}

// The side effects of a status move. Same transaction as the update, so they stand or fall
// together: pending approval, outbox event.
async function afterTransition(
  ctx: CommandContext,
  id: string,
  from: CaseStatus,
  to: CaseStatus,
  caseType: string,
  newVersion: number,
  title: string,
  queue: string,
) {
  const ref = await caseRef(id);
  if (to === "Ready") {
    await ctx.db.query(
      `INSERT INTO app.approvals (workspace_id, case_id, proposed_action, proposed_payload, requested_by)
       VALUES ($1, $2, 'approve_case', $3, $4)`,
      [ctx.workspaceId, id, JSON.stringify({ title }), ctx.actorRole],
    );
  }
  if (from === "Ready" && to === "Needs Review") {
    await ctx.db.query(
      `UPDATE app.approvals SET status = 'withdrawn', decided_at = now(), actor_id = $3
        WHERE workspace_id = $1 AND case_id = $2 AND status = 'pending'`,
      [ctx.workspaceId, id, ctx.actorId],
    );
  }
  if (from === "Draft" && to === "Intake") {
    await emitEvent(ctx, "case.created", `case:${id}:created`, ref, {
      caseRef: ref,
      caseType,
      queue,
    });
  }
  if (to === "Needs Review") {
    const reason = from === "Closed" ? "reopened" : from === "Ready" ? "returned" : "intake";
    await emitEvent(ctx, "case.needs_review", `case:${id}:review:${newVersion}`, ref, {
      caseRef: ref,
      reason,
      queue,
    });
  }
}

export type NewCase = {
  title: string;
  customerId: string;
  caseType: string;
  queue: string;
  dueAt: string | null;
  draft: boolean;
};

export async function createCase(ctx: CommandContext, input: NewCase) {
  const role = workflowRole(ctx);
  if (!role) throw forbidden();
  const owned = await ctx.db.query(
    "SELECT 1 FROM app.customers WHERE workspace_id = $1 AND id = $2",
    [ctx.workspaceId, input.customerId],
  );
  if (owned.rowCount === 0) throw invalidRequest("Unknown customer");
  const status: CaseStatus = input.draft ? "Draft" : "Intake";
  if (!input.draft) checkTransition(ctx, "Draft", "Intake", "update");
  const { rows } = await ctx.db.query(
    `INSERT INTO app.cases (workspace_id, customer_id, title, case_type, status, due_at, queue)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      ctx.workspaceId,
      input.customerId,
      input.title,
      input.caseType,
      status,
      input.dueAt,
      input.queue,
    ],
  );
  const id = rows[0].id as string;
  for (const [position, item] of checklistFor(input.caseType).entries()) {
    await ctx.db.query(
      `INSERT INTO app.case_checklist_items (workspace_id, case_id, item_key, label, position, required)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.workspaceId, id, item.key, item.label, position, item.required],
    );
  }
  const created = (await findCase(ctx.db, ctx.workspaceId, false, id)) as Row;
  await writeAudit(ctx, "case.created", id, { after: caseDto(created), summary: `${status}` });
  if (!input.draft) {
    await afterTransition(ctx, id, "Draft", "Intake", input.caseType, 1, input.title, input.queue);
  }
  return caseDto(created);
}

export type CasePatch = {
  version: number;
  title?: string;
  dueAt?: string | null;
  status?: CaseStatus;
  reason?: string;
};

export async function updateCase(
  ctx: CommandContext,
  seesTemplate: boolean,
  id: string,
  patch: CasePatch,
) {
  const before = await lockedCase(ctx, seesTemplate, id);
  if (before.version !== patch.version) throw stale();
  const from = before.status as CaseStatus;
  const to = patch.status;
  if (to && to !== from) {
    checkTransition(ctx, from, to, "update", patch.reason);
    await checkChecklistGate(ctx, id, to);
  } else if (to === from) {
    throw invalidTransition("The case is already in that status.");
  }
  if (detailsFrozen(from) && (patch.title !== undefined || patch.dueAt !== undefined)) {
    throw detailsLocked();
  }
  const title = patch.title ?? (before.title as string);
  const updated = await ctx.db.query(
    `UPDATE app.cases SET title = $3, due_at = $4, status = $5, version = version + 1
      WHERE workspace_id = $1 AND id = $2 AND version = $6 RETURNING version`,
    [
      ctx.workspaceId,
      id,
      title,
      patch.dueAt === undefined ? before.due_at : patch.dueAt,
      to ?? from,
      patch.version,
    ],
  );
  if (updated.rowCount === 0) throw stale();
  if (to) {
    await afterTransition(
      ctx,
      id,
      from,
      to,
      before.case_type as string,
      updated.rows[0].version,
      title,
      before.queue as string,
    );
  }
  const after = (await findCase(ctx.db, ctx.workspaceId, false, id)) as Row;
  await writeAudit(ctx, to ? "case.status_changed" : "case.updated", id, {
    before: caseDto(before),
    after: caseDto(after),
    summary: to ? `${from} to ${to}${patch.reason ? `: ${patch.reason}` : ""}` : "Details edited",
  });
  return caseDto(after);
}

export async function reopenCase(
  ctx: CommandContext,
  seesTemplate: boolean,
  id: string,
  version: number,
  reason: string,
) {
  const before = await lockedCase(ctx, seesTemplate, id);
  if (before.version !== version) throw stale();
  const from = before.status as CaseStatus;
  checkTransition(ctx, from, "Needs Review", "reopen", reason);
  const updated = await ctx.db.query(
    `UPDATE app.cases SET status = 'Needs Review', version = version + 1
      WHERE workspace_id = $1 AND id = $2 AND version = $3 RETURNING version`,
    [ctx.workspaceId, id, version],
  );
  if (updated.rowCount === 0) throw stale();
  await afterTransition(
    ctx,
    id,
    from,
    "Needs Review",
    before.case_type as string,
    updated.rows[0].version,
    before.title as string,
    before.queue as string,
  );
  const after = (await findCase(ctx.db, ctx.workspaceId, false, id)) as Row;
  await writeAudit(ctx, "case.reopened", id, {
    before: caseDto(before),
    after: caseDto(after),
    summary: `Closed to Needs Review: ${reason}`,
  });
  return caseDto(after);
}

export type Handoff = {
  toAssigneeId?: string;
  toQueue?: string;
  reason: string;
  dueAt?: string;
  expectedCaseVersion: number;
  inventoryItemId?: string;
};

const unauthorizedAssignee = () =>
  new ApiError(403, "unauthorized_assignee", "That person can't take this case.");

async function eligibleAssignee(db: Db, workspaceId: string, id: string) {
  const { rows } = await db.query(
    `SELECT id, display_name, team FROM app.assignees
      WHERE workspace_id = $1 AND id = $2 AND active AND can_receive_cases`,
    [workspaceId, id],
  );
  return rows[0];
}

// An outstanding checklist item doesn't block a handoff: it travels with the case and the
// history records how many were open (JOB-TEST-02).
export async function handOffCase(
  ctx: CommandContext,
  seesTemplate: boolean,
  id: string,
  input: Handoff,
) {
  const before = await lockedCase(ctx, seesTemplate, id);
  if (before.version !== input.expectedCaseVersion) throw stale();
  if (before.status === "Closed") throw invalidTransition("A closed case can't be handed off.");
  if (input.dueAt !== undefined && detailsFrozen(before.status)) throw detailsLocked();
  // Same answer for another workspace's ID, an unknown ID and an ineligible person.
  const assignee = input.toAssigneeId
    ? await eligibleAssignee(ctx.db, ctx.workspaceId, input.toAssigneeId)
    : null;
  if (input.toAssigneeId && !assignee) throw unauthorizedAssignee();
  const toQueue = (assignee?.team ?? input.toQueue) as string;
  if (assignee ? assignee.id === before.assignee_id : toQueue === before.queue) {
    throw invalidRequest("The case is already there");
  }
  // A cross-reference to a source-backed item, read-only. Same 404 as any unknown ID.
  if (input.inventoryItemId) {
    const item = await ctx.db.query(
      "SELECT 1 FROM app.inventory_items WHERE workspace_id = $1 AND id = $2",
      [ctx.workspaceId, input.inventoryItemId],
    );
    if (item.rowCount === 0) throw notFound();
  }
  const dueAt = input.dueAt ?? before.due_at;
  const updated = await ctx.db.query(
    `UPDATE app.cases SET assignee_id = $3, queue = $4, due_at = $5, version = version + 1
      WHERE workspace_id = $1 AND id = $2 AND version = $6 RETURNING version`,
    [ctx.workspaceId, id, assignee?.id ?? null, toQueue, dueAt, input.expectedCaseVersion],
  );
  if (updated.rowCount === 0) throw stale();
  const items = await loadChecklist(ctx.db, ctx.workspaceId, id);
  const openRequired = openRequiredCount(items);
  await ctx.db.query(
    `INSERT INTO app.consultant_handoffs (workspace_id, case_id, from_assignee_id, to_assignee_id,
       from_queue, to_queue, due_at, checklist_version, open_required, reason, actor_type, actor_id,
       expected_case_version, inventory_item_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      ctx.workspaceId,
      id,
      before.assignee_id,
      assignee?.id ?? null,
      before.queue,
      toQueue,
      dueAt,
      items.reduce((sum, i) => sum + i.version, 0),
      openRequired,
      input.reason,
      ctx.actorType,
      ctx.actorId,
      input.expectedCaseVersion,
      input.inventoryItemId ?? null,
    ],
  );
  const after = (await findCase(ctx.db, ctx.workspaceId, false, id)) as Row;
  await writeAudit(ctx, "case.handoff", id, {
    before: caseDto(before),
    after: caseDto(after),
    summary: `To ${assignee?.display_name ?? toQueue}: ${input.reason}`,
  });
  return caseDto(after);
}

export async function updateChecklistItem(
  ctx: CommandContext,
  seesTemplate: boolean,
  caseId: string,
  itemId: string,
  input: { state: string; version: number; evidenceRef?: string },
) {
  const parent = await lockedCase(ctx, seesTemplate, caseId);
  if (!checklistEditable(parent.status as CaseStatus)) {
    throw new ApiError(
      409,
      "checklist_locked",
      "The checklist is locked once a case is Ready. Return it to review first.",
    );
  }
  const current = await ctx.db.query(
    `SELECT label, state FROM app.case_checklist_items
      WHERE workspace_id = $1 AND case_id = $2 AND id = $3`,
    [ctx.workspaceId, caseId, itemId],
  );
  if (!current.rows[0]) throw notFound();
  // Reopening an item drops its old evidence, which no longer describes the item.
  const { rows, rowCount } = await ctx.db.query(
    `UPDATE app.case_checklist_items
        SET state = $4,
            evidence_ref = CASE WHEN $4 = 'open' THEN NULL ELSE coalesce($5, evidence_ref) END,
            version = version + 1
      WHERE workspace_id = $1 AND case_id = $2 AND id = $3 AND version = $6
      RETURNING id, state, version, evidence_ref`,
    [ctx.workspaceId, caseId, itemId, input.state, input.evidenceRef ?? null, input.version],
  );
  if (rowCount === 0) throw stale();
  // The checklist is part of what a reviewer read, so a page from before this edit is stale.
  await ctx.db.query(
    "UPDATE app.cases SET version = version + 1 WHERE workspace_id = $1 AND id = $2",
    [ctx.workspaceId, caseId],
  );
  await writeAudit(ctx, "checklist.updated", caseId, {
    before: current.rows[0],
    after: rows[0],
    summary: `${current.rows[0].label}: ${current.rows[0].state} to ${input.state}`,
  });
  return {
    id: rows[0].id,
    state: rows[0].state,
    version: rows[0].version,
    evidenceRef: rows[0].evidence_ref,
  };
}

// PRD P2.4: the decision, the state change, the audit row and the outbox row commit together
// or not at all. Every failure path throws, and withWorkspace rolls the transaction back.
export async function decideApproval(
  ctx: CommandContext,
  approvalId: string,
  input: { decision: "approve" | "reject"; caseVersion: number; reason?: string },
) {
  const found = await ctx.db.query(
    "SELECT case_id FROM app.approvals WHERE workspace_id = $1 AND id = $2",
    [ctx.workspaceId, approvalId],
  );
  const caseId = found.rows[0]?.case_id as string | undefined;
  if (!caseId) throw notFound();
  if (!(await lockCase(ctx.db, ctx.workspaceId, caseId))) throw notFound();
  // Read after the lock: a concurrent decision has committed by now, or hasn't started.
  const approval = (
    await ctx.db.query("SELECT status FROM app.approvals WHERE workspace_id = $1 AND id = $2", [
      ctx.workspaceId,
      approvalId,
    ])
  ).rows[0];
  if (approval?.status !== "pending") {
    throw new ApiError(409, "already_decided", "This approval has already been decided.");
  }
  const before = (await findCase(ctx.db, ctx.workspaceId, false, caseId)) as Row;
  if (before.version !== input.caseVersion) throw stale();
  const from = before.status as CaseStatus;
  const to: CaseStatus = input.decision === "approve" ? "Approved" : "Needs Review";
  checkTransition(ctx, from, to, "approval", input.reason);
  const status = input.decision === "approve" ? "approved" : "rejected";
  await ctx.db.query(
    `UPDATE app.approvals SET status = $3, actor_id = $4, decided_at = now(), reason = $5
      WHERE workspace_id = $1 AND id = $2 AND status = 'pending'`,
    [ctx.workspaceId, approvalId, status, ctx.actorId, input.reason ?? null],
  );
  const updated = await ctx.db.query(
    `UPDATE app.cases SET status = $3, version = version + 1
      WHERE workspace_id = $1 AND id = $2 AND version = $4 RETURNING version`,
    [ctx.workspaceId, caseId, to, input.caseVersion],
  );
  if (updated.rowCount === 0) throw stale();
  const after = (await findCase(ctx.db, ctx.workspaceId, false, caseId)) as Row;
  await writeAudit(ctx, "approval.completed", caseId, {
    before: caseDto(before),
    after: caseDto(after),
    summary: `${status}${input.reason ? `: ${input.reason}` : ""}`,
  });
  const ref = await caseRef(caseId);
  await emitEvent(ctx, "approval.completed", `approval:${approvalId}`, ref, {
    caseRef: ref,
    decision: status,
    queue: before.queue as string,
  });
  if (to === "Needs Review") {
    await emitEvent(
      ctx,
      "case.needs_review",
      `case:${caseId}:review:${updated.rows[0].version}`,
      ref,
      { caseRef: ref, reason: "returned", queue: before.queue as string },
    );
  }
  return { approvalId, status, case: caseDto(after) };
}
