// P5.1, P5.2, P5.3 and P5.4 commands: attach a fixture, request a review, retry, decide.
// The model's suggestion never reaches a record by itself. A reviewer's accept commits allowed
// checklist changes through updateChecklistItem, the same version-checked command a person uses,
// in one transaction with the decision. No AI event type exists (PRD 9.1 is closed).
import type { Actor } from "../auth/actor";
import { type Client, type Db, inWorkspaceTx, withClient, withWorkspace } from "../db";
import type { CaseStatus } from "../domain/caseStatus";
import type { Bindings } from "../env";
import { ApiError, forbidden, notFound } from "../http/errors";
import { callLiveModel, GatewayError, gatewayState, type LiveConfig } from "../ai/gateway";
import { type CaseFacts, evaluatePolicy } from "../ai/policy";
import {
  type Field,
  FIELDS,
  PROMPT_VERSION,
  type ReviewOutput,
  type Segment,
  safeValue,
} from "../ai/schema";
import { validateOutput } from "../ai/validate";
import { findCase, loadChecklist, lockCase } from "./cases";
import { updateChecklistItem } from "./caseCommands";
import { type CommandContext, commandContext, writeAudit } from "./records";

export const FIXTURE_LABEL = "Deterministic demonstration fixture";
export const LIVE_LABEL = "Live model output";
const MAX_DOCUMENTS_PER_CASE = 20;
const MAX_ATTEMPTS = 5;
// Fixture reviews a workspace may request per UTC day. Live reviews have their own budget.
const DAILY_REVIEWS = { demo: 25, owner: 200 };

// pg rows are untyped. Every value read from one is checked or comes from a typed column.
// biome-ignore lint/suspicious/noExplicitAny: database rows
type Row = Record<string, any>;
const hex = (b: Uint8Array | null | undefined) => (b ? Buffer.from(b).toString("hex") : null);
const conflict = (code: string, message: string) => new ApiError(409, code, message);
const today = "(now() AT TIME ZONE 'UTC')::date";

// ---------- documents ----------

export async function listFixtures(db: Db) {
  const { rows } = await db.query(
    `SELECT fixture_id, title, category, kind, pages, text_layer FROM app.fixture_documents
      ORDER BY fixture_id`,
  );
  return {
    items: rows.map((r) => ({
      fixtureId: r.fixture_id,
      title: r.title,
      category: r.category,
      kind: r.kind,
      pages: r.pages,
      textLayer: r.text_layer,
    })),
  };
}

export async function attachFixture(
  ctx: CommandContext,
  seesTemplate: boolean,
  caseId: string,
  fixtureId: string,
) {
  const seen = await findCase(ctx.db, ctx.workspaceId, seesTemplate, caseId);
  if (!seen) throw notFound();
  if (seen.read_only) throw forbidden();
  await lockCase(ctx.db, ctx.workspaceId, caseId);
  // What a reviewer approved stays what was approved, so a document joins before Ready.
  const status = (await findCase(ctx.db, ctx.workspaceId, false, caseId))?.status;
  if (status === "Ready" || status === "Approved" || status === "Closed") {
    throw conflict(
      "case_locked",
      "Documents are added before a case is Ready. Return it to review first.",
    );
  }
  const fixture = (
    await ctx.db.query(
      "SELECT fixture_id, title, category, sha256, size FROM app.fixture_documents WHERE fixture_id = $1",
      [fixtureId],
    )
  ).rows[0];
  if (!fixture) throw new ApiError(422, "unknown_fixture", "That fixture isn't on the list.");
  const n = await ctx.db.query(
    "SELECT count(*)::int AS n FROM app.documents WHERE workspace_id = $1 AND case_id = $2",
    [ctx.workspaceId, caseId],
  );
  if (n.rows[0].n >= MAX_DOCUMENTS_PER_CASE) {
    throw conflict("document_limit", "This case already has the most documents it can hold.");
  }
  const { rows } = await ctx.db.query(
    `INSERT INTO app.documents (workspace_id, case_id, title, fixture_id, category, sha256, size,
                                verified_type, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'application/pdf', 'Ready')
     RETURNING id, title, fixture_id, category, status, size, sha256, created_at`,
    [
      ctx.workspaceId,
      caseId,
      fixture.title,
      fixture.fixture_id,
      fixture.category,
      fixture.sha256,
      fixture.size,
    ],
  );
  await writeAudit(ctx, "document.attached", caseId, {
    after: { documentId: rows[0].id, fixtureId },
    summary: `Attached fixture ${fixtureId}`,
  });
  return documentDto(rows[0]);
}

const documentDto = (r: Row) => ({
  id: r.id,
  caseId: r.case_id,
  title: r.title,
  fixtureId: r.fixture_id,
  category: r.category,
  status: r.status,
  size: r.size,
  sha256: hex(r.sha256),
  createdAt: r.created_at?.toISOString?.() ?? null,
});

// A document the actor may read: its own, or a shared template one for a guest.
async function findDocument(db: Db, workspaceId: string, seesTemplate: boolean, id: string) {
  const { rows } = await db.query(
    `SELECT d.*, d.workspace_id <> $1 AS read_only FROM app.documents d
      WHERE d.id = $2 AND (d.workspace_id = $1 OR ($3 AND d.workspace_id =
            (SELECT id FROM app.workspaces WHERE mode = 'template')))`,
    [workspaceId, id, seesTemplate],
  );
  return rows[0] as Row | undefined;
}

async function segmentsFor(db: Db, fixtureId: string | null): Promise<Segment[] | null> {
  if (!fixtureId) return null;
  const { rows } = await db.query(
    "SELECT segments FROM app.fixture_documents WHERE fixture_id = $1",
    [fixtureId],
  );
  return (rows[0]?.segments as Segment[] | undefined) ?? null;
}

export async function documentDetail(db: Db, actor: Actor, id: string) {
  const doc = await findDocument(db, actor.workspaceId, actor.kind === "guest", id);
  if (!doc) return null;
  const segments = await segmentsFor(db, doc.fixture_id);
  const reviews = doc.read_only
    ? []
    : (
        await db.query(
          `SELECT id FROM app.ai_reviews WHERE workspace_id = $1 AND document_id = $2
            ORDER BY requested_at DESC, id LIMIT 10`,
          [actor.workspaceId, id],
        )
      ).rows;
  return {
    ...documentDto(doc),
    readOnly: doc.read_only,
    source: "Text extracted at build time from a fictional PDF. The app never parses a PDF.",
    segments: segments ?? [],
    reviews: await Promise.all(reviews.map((r) => reviewDetail(db, actor.workspaceId, r.id))),
  };
}

// ---------- reviews ----------

async function caseFacts(db: Db, workspaceId: string, caseId: string): Promise<CaseFacts & Row> {
  const c = (await findCase(db, workspaceId, false, caseId)) as Row;
  const checklist = await loadChecklist(db, workspaceId, caseId);
  return {
    ...c,
    status: c.status as CaseStatus,
    customerName: c.customer as string,
    checklist: checklist.map((i) => ({
      key: i.item_key,
      state: i.state,
      id: i.id,
      version: i.version,
    })),
  };
}

const effectiveFields = (output: ReviewOutput, edits: Row | null) => {
  const fields: Partial<Record<Field, string>> = { ...output.extractedFields };
  for (const [k, v] of Object.entries(edits ?? {})) {
    if (v === null) delete fields[k as Field];
    else fields[k as Field] = v as string;
  }
  return fields;
};

export async function reviewDetail(db: Db, workspaceId: string, id: string) {
  const { rows } = await db.query(
    `SELECT r.*, d.case_id, d.title AS document_title FROM app.ai_reviews r
       JOIN app.documents d ON d.workspace_id = r.workspace_id AND d.id = r.document_id
      WHERE r.workspace_id = $1 AND r.id = $2`,
    [workspaceId, id],
  );
  const r = rows[0];
  if (!r) return null;
  const output = r.extraction as ReviewOutput | null;
  let policy = null;
  if (output) {
    const facts = await caseFacts(db, workspaceId, r.case_id);
    const edited = r.reviewer_edits !== null;
    policy = evaluatePolicy(
      edited ? { ...output, abstained: false } : output,
      effectiveFields(output, r.reviewer_edits),
      facts,
      edited,
    );
  }
  return {
    id: r.id,
    documentId: r.document_id,
    documentTitle: r.document_title,
    caseId: r.case_id,
    status: r.status,
    version: r.version,
    mode: r.mode,
    label: r.mode === "live" ? LIVE_LABEL : FIXTURE_LABEL,
    modelVersion: r.model_version,
    promptVersion: r.prompt_version,
    inputSha256: hex(r.input_sha256),
    suggestion: output,
    citations: r.citations ?? [],
    validation: r.validation,
    abstainReason: r.abstain_reason,
    errorCode: r.error_code,
    reviewerEdits: r.reviewer_edits,
    applied: r.applied,
    policy,
    attempts: r.attempts,
    latencyMs: r.latency_ms,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    // Estimated provider cost in millionths of a US dollar. Always 0 for a fixture.
    costMicroUsd: r.cost_units,
    requestedAt: r.requested_at.toISOString(),
    decidedAt: r.decided_at?.toISOString() ?? null,
    decisionReason: r.decision_reason,
  };
}

type Target = { doc: Row; segments: Segment[] };

// Loads and locks the document for a new review. Template documents are read-only.
async function lockTarget(ctx: CommandContext, seesTemplate: boolean, documentId: string) {
  const doc = await findDocument(ctx.db, ctx.workspaceId, seesTemplate, documentId);
  if (!doc) throw notFound();
  if (doc.read_only) throw forbidden();
  await lockCase(ctx.db, ctx.workspaceId, doc.case_id);
  if (doc.status !== "Ready" || !doc.sha256) {
    throw conflict("document_not_ready", "This document isn't ready for review.");
  }
  const busy = await ctx.db.query(
    `SELECT 1 FROM app.ai_reviews WHERE workspace_id = $1 AND document_id = $2
        AND status IN ('Queued','Processing')`,
    [ctx.workspaceId, documentId],
  );
  if (busy.rowCount) throw conflict("review_in_progress", "A review of this document is running.");
  const segments = await segmentsFor(ctx.db, doc.fixture_id);
  if (!segments) throw conflict("document_not_ready", "This document has no stored text.");
  return { doc, segments } as Target;
}

// One counter row per workspace and UTC day, locked for each review, so parallel requests on
// different cases can't both take the last slot (independent review, P5). A fallback that
// answers a live request counts too, but is never refused: it is part of that one request.
async function takeReviewSlot(ctx: CommandContext, check = true) {
  await ctx.db.query(
    `INSERT INTO app.ai_usage (workspace_id, day) VALUES ($1, ${today}) ON CONFLICT DO NOTHING`,
    [ctx.workspaceId],
  );
  const { rows } = await ctx.db.query(
    `SELECT reviews FROM app.ai_usage WHERE workspace_id = $1 AND day = ${today} FOR UPDATE`,
    [ctx.workspaceId],
  );
  if (check && rows[0].reviews >= DAILY_REVIEWS[ctx.workspaceMode]) {
    throw new ApiError(429, "review_quota", "This workspace has used today's reviews.");
  }
  await ctx.db.query(
    `UPDATE app.ai_usage SET reviews = reviews + 1 WHERE workspace_id = $1 AND day = ${today}`,
    [ctx.workspaceId],
  );
}

// Validates and stores a result on a Processing row. Invalid output ends Failed with codes only.
async function finish(
  ctx: CommandContext,
  reviewId: string,
  caseId: string,
  raw: unknown,
  segments: Segment[],
  meta: {
    modelVersion: string;
    latencyMs: number;
    tokensIn?: number;
    tokensOut?: number;
    costMicroUsd?: number;
    fallback?: { from: string; code: string };
  },
) {
  const v = validateOutput(raw, segments);
  const validation = { ...v.validation, ...(meta.fallback ? { fallback: meta.fallback } : {}) };
  const common = [
    ctx.workspaceId,
    reviewId,
    JSON.stringify(validation),
    meta.latencyMs,
    meta.tokensIn ?? 0,
    meta.tokensOut ?? 0,
    meta.costMicroUsd ?? 0,
    meta.modelVersion,
  ];
  if (v.ok) {
    await ctx.db.query(
      `UPDATE app.ai_reviews SET status = 'Needs Human Review', validation = $3, latency_ms = $4,
              tokens_in = $5, tokens_out = $6, cost_units = $7, model_version = $8,
              extraction = $9, citations = $10, abstain_reason = $11, error_code = NULL,
              version = version + 1
        WHERE workspace_id = $1 AND id = $2 AND status = 'Processing'`,
      [...common, JSON.stringify(v.output), JSON.stringify(v.citations), v.output.abstainReason],
    );
    await writeAudit(ctx, "ai_review.ready", caseId, {
      after: { reviewId, abstained: v.output.abstained },
      summary: v.output.abstained
        ? `Review ready: abstained (${v.output.abstainReason})`
        : "Review ready for a person to decide",
    });
  } else {
    await ctx.db.query(
      `UPDATE app.ai_reviews SET status = 'Failed', validation = $3, latency_ms = $4,
              tokens_in = $5, tokens_out = $6, cost_units = $7, model_version = $8,
              error_code = 'output_rejected', version = version + 1
        WHERE workspace_id = $1 AND id = $2 AND status = 'Processing'`,
      common,
    );
    await writeAudit(ctx, "ai_review.failed", caseId, {
      after: { reviewId, errors: v.validation.errors },
      summary: `Review output rejected: ${v.validation.errors.join(", ")}`,
    });
  }
}

async function insertProcessing(
  ctx: CommandContext,
  t: Target,
  mode: "fixture" | "live",
  modelVersion: string,
) {
  const { rows } = await ctx.db.query(
    `INSERT INTO app.ai_reviews (workspace_id, document_id, model_version, prompt_version, mode,
                                 input_sha256, status, processing_started_at, attempts)
     VALUES ($1, $2, $3, $4, $5, $6, 'Processing', now(), 1) RETURNING id`,
    [ctx.workspaceId, t.doc.id, modelVersion, PROMPT_VERSION, mode, t.doc.sha256],
  );
  await writeAudit(ctx, "ai_review.requested", t.doc.case_id, {
    after: { reviewId: rows[0].id, mode },
    summary: `Review requested (${mode === "live" ? "live model" : "fixture"})`,
  });
  return rows[0].id as string;
}

// The fixture path: stored output keyed by the document hash and prompt version. One
// transaction, no network.
async function runFixture(
  ctx: CommandContext,
  reviewId: string,
  t: Target,
  fallback?: { from: string; code: string },
) {
  const { rows } = await ctx.db.query(
    `SELECT model_version, raw_output FROM app.fixture_review_outputs
      WHERE input_sha256 = $1 AND prompt_version = $2`,
    [t.doc.sha256, PROMPT_VERSION],
  );
  if (!rows[0]) {
    await ctx.db.query(
      `UPDATE app.ai_reviews SET status = 'Failed', error_code = 'fixture_missing',
              version = version + 1
        WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, reviewId],
    );
    return;
  }
  await finish(ctx, reviewId, t.doc.case_id, rows[0].raw_output, t.segments, {
    modelVersion: rows[0].model_version,
    latencyMs: 0,
    ...(fallback ? { fallback } : {}),
  });
}

// Reserves one live call against the day's budget and the concurrency cap, or says why not.
async function reserveLive(ctx: CommandContext, config: LiveConfig): Promise<string | null> {
  await ctx.db.query(
    `INSERT INTO app.ai_usage (workspace_id, day) VALUES ($1, ${today}) ON CONFLICT DO NOTHING`,
    [ctx.workspaceId],
  );
  const usage = (
    await ctx.db.query(
      `SELECT requests FROM app.ai_usage WHERE workspace_id = $1 AND day = ${today} FOR UPDATE`,
      [ctx.workspaceId],
    )
  ).rows[0];
  if (usage.requests >= config.limits.requestsPerDay) return "live_ai_daily_limit";
  const running = await ctx.db.query(
    `SELECT count(*)::int AS n FROM app.ai_reviews
      WHERE workspace_id = $1 AND mode = 'live' AND status = 'Processing'`,
    [ctx.workspaceId],
  );
  if (running.rows[0].n >= config.limits.concurrency) return "live_ai_concurrency_limit";
  await ctx.db.query(
    `UPDATE app.ai_usage SET requests = requests + 1 WHERE workspace_id = $1 AND day = ${today}`,
    [ctx.workspaceId],
  );
  return null;
}

export type ReviewRequest = { mode: "fixture" | "live" };

export async function requestReview(
  env: Bindings,
  actor: Actor,
  requestId: string,
  documentId: string,
  input: ReviewRequest,
) {
  if (input.mode === "live" && actor.kind !== "owner") throw forbidden();
  return withClient(env.HYPERDRIVE, async (client) => {
    const ctxFor = (db: Db) => commandContext(db, actor, requestId);
    // Step 1: one transaction that either finishes a fixture review or reserves a live call.
    const step1 = await inWorkspaceTx(client, actor.workspaceId, async () => {
      const ctx = ctxFor(client);
      const t = await lockTarget(ctx, actor.kind === "guest", documentId);
      await takeReviewSlot(ctx);
      let fallback: { from: string; code: string } | undefined;
      if (input.mode === "live") {
        const state = gatewayState(env);
        if (!state.ready) fallback = { from: "live", code: state.code };
        else if (t.segments.length === 0) fallback = { from: "live", code: "no_text_no_call" };
        else {
          const refused = await reserveLive(ctx, state.config);
          if (refused) fallback = { from: "live", code: refused };
          else {
            const id = await insertProcessing(
              ctx,
              t,
              "live",
              `${state.config.provider}:${state.config.model}`,
            );
            return { live: { id, t, config: state.config } };
          }
        }
      }
      const id = await insertProcessing(ctx, t, "fixture", "fixture");
      await runFixture(ctx, id, t, fallback);
      return { done: id, fallback };
    });
    if ("done" in step1) {
      return {
        review: await inWorkspaceTx(client, actor.workspaceId, () =>
          reviewDetail(client, actor.workspaceId, step1.done as string),
        ),
        ...(step1.fallback ? { degraded: step1.fallback.code } : {}),
      };
    }
    // Step 2: the provider call, outside any transaction.
    const { id, t, config } = step1.live;
    let outcome: Awaited<ReturnType<typeof callLiveModel>> | GatewayError;
    try {
      outcome = await callLiveModel(config, t.segments);
    } catch (e) {
      outcome = e instanceof GatewayError ? e : new GatewayError("provider_unavailable");
    }
    // Step 3: store the result, or fail the live row and give the labeled fixture instead.
    return inWorkspaceTx(client, actor.workspaceId, async () => {
      const ctx = ctxFor(client);
      if (!(outcome instanceof GatewayError)) {
        await client.query(
          `UPDATE app.ai_usage SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3,
                  cost_micro_usd = cost_micro_usd + $4
            WHERE workspace_id = $1 AND day = ${today}`,
          [ctx.workspaceId, outcome.tokensIn, outcome.tokensOut, outcome.costMicroUsd],
        );
        await finish(ctx, id, t.doc.case_id, outcome.raw, t.segments, {
          modelVersion: `${config.provider}:${config.model}`,
          latencyMs: outcome.latencyMs,
          tokensIn: outcome.tokensIn,
          tokensOut: outcome.tokensOut,
          costMicroUsd: outcome.costMicroUsd,
        });
        const review = await reviewDetail(client, ctx.workspaceId, id);
        if (review?.status === "Needs Human Review") return { review };
        const fb = await fixtureFallback(ctx, t, "output_rejected");
        return { review, fallback: fb, degraded: "output_rejected" };
      }
      // A refused answer was still a paid call: its usage counts against the budget.
      const used = outcome.usage ?? { tokensIn: 0, tokensOut: 0, costMicroUsd: 0 };
      await client.query(
        `UPDATE app.ai_usage SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3,
                cost_micro_usd = cost_micro_usd + $4
          WHERE workspace_id = $1 AND day = ${today}`,
        [ctx.workspaceId, used.tokensIn, used.tokensOut, used.costMicroUsd],
      );
      await client.query(
        `UPDATE app.ai_reviews SET status = 'Failed', error_code = $3, version = version + 1,
                tokens_in = $4, tokens_out = $5, cost_units = $6
          WHERE workspace_id = $1 AND id = $2 AND status = 'Processing'`,
        [ctx.workspaceId, id, outcome.code, used.tokensIn, used.tokensOut, used.costMicroUsd],
      );
      await writeAudit(ctx, "ai_review.failed", t.doc.case_id, {
        after: { reviewId: id, code: outcome.code },
        summary: `Live review failed: ${outcome.code}`,
      });
      const fb = await fixtureFallback(ctx, t, outcome.code);
      return {
        review: await reviewDetail(client, ctx.workspaceId, id),
        fallback: fb,
        degraded: outcome.code,
      };
    });
  });
}

async function fixtureFallback(ctx: CommandContext, t: Target, code: string) {
  await takeReviewSlot(ctx, false);
  const fid = await insertProcessing(ctx, t, "fixture", "fixture");
  await runFixture(ctx, fid, t, { from: "live", code });
  return reviewDetail(ctx.db, ctx.workspaceId, fid);
}

// Failed -> Queued -> Processing on the same row, within the attempt cap, for fixture reviews.
// A retry never calls a provider, so it can't become a hidden paid loop (D-068).
export async function retryReview(
  env: Bindings,
  actor: Actor,
  requestId: string,
  reviewId: string,
) {
  return withClient(env.HYPERDRIVE, (client: Client) =>
    inWorkspaceTx(client, actor.workspaceId, async () => {
      const ctx = commandContext(client, actor, requestId);
      const r = (
        await client.query("SELECT * FROM app.ai_reviews WHERE workspace_id = $1 AND id = $2", [
          ctx.workspaceId,
          reviewId,
        ])
      ).rows[0];
      if (!r) throw notFound();
      const doc = await findDocument(client, ctx.workspaceId, false, r.document_id);
      if (!doc) throw notFound();
      await lockCase(client, ctx.workspaceId, doc.case_id);
      const locked = (
        await client.query(
          "SELECT status, attempts FROM app.ai_reviews WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
          [ctx.workspaceId, reviewId],
        )
      ).rows[0];
      if (locked.status !== "Failed")
        throw conflict("not_failed", "Only a failed review can be retried.");
      // A failed live row keeps its record of the paid attempt. Trying live again is a new request.
      if (r.mode === "live") {
        throw conflict("live_retry_is_new_request", "Request a new review to try live again.");
      }
      if (locked.attempts >= MAX_ATTEMPTS) {
        throw conflict("retry_limit", "This review has been retried as often as it can be.");
      }
      if (doc.status !== "Ready" || !doc.sha256) {
        throw conflict("document_not_ready", "This document isn't ready for review.");
      }
      const busy = await client.query(
        `SELECT 1 FROM app.ai_reviews WHERE workspace_id = $1 AND document_id = $2
            AND status IN ('Queued','Processing')`,
        [ctx.workspaceId, doc.id],
      );
      if (busy.rowCount)
        throw conflict("review_in_progress", "A review of this document is running.");
      await takeReviewSlot(ctx);
      const segments = (await segmentsFor(client, doc.fixture_id)) ?? [];
      await client.query(
        `UPDATE app.ai_reviews SET status = 'Processing', processing_started_at = now(),
                attempts = attempts + 1, error_code = NULL, version = version + 1
          WHERE workspace_id = $1 AND id = $2`,
        [ctx.workspaceId, reviewId],
      );
      await writeAudit(ctx, "ai_review.retried", doc.case_id, {
        after: { reviewId },
        summary: "Review retried",
      });
      await runFixture(ctx, reviewId, { doc, segments });
      return reviewDetail(client, ctx.workspaceId, reviewId);
    }),
  );
}

export type Decision = {
  decision: "accept" | "accept_with_edits" | "reject";
  version: number;
  reason?: string;
  edits?: Record<string, string | null>;
  caseVersion?: number;
  // The changes the reviewer was shown, as "itemKey:state". Required with caseVersion.
  expectApply?: string[];
};

const itemId = (i: { itemKey: string; state: string }) => `${i.itemKey}:${i.state}`;
const sameList = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((x, n) => x === [...b].sort()[n]);

// The edit preview: what an accept with these edits would apply on the case as it is now.
// Read-only. The reviewer sees this list, then sends it back with the decision.
export async function previewEdits(db: Db, workspaceId: string, reviewId: string, edits: unknown) {
  const r = (
    await db.query(
      `SELECT r.*, d.case_id FROM app.ai_reviews r
         JOIN app.documents d ON d.workspace_id = r.workspace_id AND d.id = r.document_id
        WHERE r.workspace_id = $1 AND r.id = $2`,
      [workspaceId, reviewId],
    )
  ).rows[0] as Row | undefined;
  if (!r) throw notFound();
  if (r.status !== "Needs Human Review") throw conflict("not_ready", "This review isn't open.");
  const output = r.extraction as ReviewOutput;
  if (output.abstained) throw abstainedEdit();
  const checked = checkEdits(edits);
  const facts = await caseFacts(db, workspaceId, r.case_id);
  const policy = evaluatePolicy(
    { ...output, abstained: false },
    effectiveFields(output, checked),
    facts,
    true,
  );
  return { policy, caseVersion: facts.version, reviewVersion: r.version };
}

const abstainedEdit = () =>
  new ApiError(422, "invalid_edit", "This review abstained, so there is no suggestion to edit.");

export function checkEdits(edits: unknown): Record<Field, string | null> {
  if (typeof edits !== "object" || edits === null || Array.isArray(edits)) {
    throw new ApiError(422, "invalid_edit", "Edits must name schema fields.");
  }
  const out: Partial<Record<Field, string | null>> = {};
  const entries = Object.entries(edits);
  if (entries.length === 0 || entries.length > FIELDS.length) {
    throw new ApiError(422, "invalid_edit", "Edit at least one field.");
  }
  for (const [k, v] of entries) {
    if (!(FIELDS as readonly string[]).includes(k)) {
      throw new ApiError(422, "invalid_edit", "Only schema fields can be edited.");
    }
    if (v !== null && !safeValue(k as Field, v)) {
      throw new ApiError(422, "invalid_edit", `That ${k} value doesn't pass the field rules.`);
    }
    out[k as Field] = v as string | null;
  }
  return out as Record<Field, string | null>;
}

export async function decideReview(ctx: CommandContext, reviewId: string, input: Decision) {
  const head = (
    await ctx.db.query(
      `SELECT d.case_id FROM app.ai_reviews r
         JOIN app.documents d ON d.workspace_id = r.workspace_id AND d.id = r.document_id
        WHERE r.workspace_id = $1 AND r.id = $2`,
      [ctx.workspaceId, reviewId],
    )
  ).rows[0];
  if (!head) throw notFound();
  // Same lock order as every case command: the case first, then what hangs off it.
  if (!(await lockCase(ctx.db, ctx.workspaceId, head.case_id))) throw notFound();
  const r = (
    await ctx.db.query(
      "SELECT * FROM app.ai_reviews WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
      [ctx.workspaceId, reviewId],
    )
  ).rows[0] as Row;
  if (["Accepted", "Accepted with Edits", "Rejected"].includes(r.status)) {
    throw conflict("already_decided", "This review has already been decided.");
  }
  if (r.status !== "Needs Human Review") {
    throw conflict("not_ready", "This review isn't ready for a decision.");
  }
  if (r.version !== input.version) {
    throw conflict("stale_review", "This review changed. Reload and try again.");
  }
  const output = r.extraction as ReviewOutput;
  // An abstention isn't a suggestion. Values the extractor declined to stand behind must not
  // drive changes just because a reviewer edited some other field (independent review, P5).
  if (input.decision === "accept_with_edits" && output.abstained) throw abstainedEdit();
  const edits = input.decision === "accept_with_edits" ? checkEdits(input.edits) : null;
  if (
    edits &&
    Object.entries(edits).every(([k, v]) => (output.extractedFields[k as Field] ?? null) === v)
  ) {
    throw new ApiError(422, "invalid_edit", "The edits don't change anything.");
  }
  const facts = await caseFacts(ctx.db, ctx.workspaceId, head.case_id);
  const policy = evaluatePolicy(
    edits ? { ...output, abstained: false } : output,
    effectiveFields(output, edits),
    facts,
    edits !== null,
  );

  const applied: Row[] = [];
  if (input.decision !== "reject" && input.caseVersion !== undefined) {
    // The reviewer saw this case at caseVersion. Anything newer and nothing changes.
    if (facts.version !== input.caseVersion) {
      throw conflict("stale_version", "Someone changed this case. Reload and try again.");
    }
    // Apply exactly what the reviewer was shown, or nothing.
    if (!input.expectApply || !sameList(input.expectApply, policy.apply.map(itemId))) {
      throw conflict("apply_changed", "The changes to apply are different now. Review them again.");
    }
    const cited = (field: string) =>
      (r.citations as { field: string; segmentId: string }[])
        .filter((c) => c.field === field)
        .map((c) => c.segmentId);
    for (const item of policy.apply) {
      const row = facts.checklist.find((i) => i.key === item.itemKey) as Row;
      const basis =
        item.itemKey === "scope_confirmed"
          ? ["scopeSigned"]
          : item.itemKey === "renewal_terms_confirmed"
            ? ["serviceEnd"]
            : ["clientName", "billingContact"];
      const sources = edits ? [] : basis.flatMap(cited);
      const evidenceRef = `ai-review:${reviewId.slice(0, 8)}${
        edits ? " reviewer-edited" : sources.length ? ` ${sources.join(",")}` : ""
      }`.slice(0, 200);
      const out = await updateChecklistItem(ctx, false, head.case_id, row.id, {
        state: item.state,
        version: row.version,
        evidenceRef,
      });
      applied.push({
        itemKey: item.itemKey,
        state: item.state,
        checklistItemId: out.id,
        evidenceRef,
      });
    }
  }
  const status =
    input.decision === "reject" ? "Rejected" : edits ? "Accepted with Edits" : "Accepted";
  await ctx.db.query(
    `UPDATE app.ai_reviews SET status = $3, reviewer_edits = $4, decided_by = $5, decided_at = now(),
            decision_reason = $6, applied = $7, version = version + 1
      WHERE workspace_id = $1 AND id = $2`,
    [
      ctx.workspaceId,
      reviewId,
      status,
      edits ? JSON.stringify(edits) : null,
      ctx.actorRole,
      input.reason ?? null,
      input.caseVersion !== undefined && status !== "Rejected" ? JSON.stringify(applied) : null,
    ],
  );
  await writeAudit(ctx, "ai_review.decided", head.case_id, {
    before: { reviewId, status: r.status },
    after: { reviewId, status, applied: applied.map((a) => `${a.itemKey}:${a.state}`) },
    summary: `${status}${applied.length ? `, applied ${applied.map((a) => a.itemKey).join(", ")}` : ""}${
      input.reason ? `: ${input.reason}` : ""
    }`,
  });
  const review = await reviewDetail(ctx.db, ctx.workspaceId, reviewId);
  const after = await findCase(ctx.db, ctx.workspaceId, false, head.case_id);
  return { review, caseVersion: after?.version };
}

export const withReviewTx = <T>(env: Bindings, actor: Actor, fn: (db: Db) => Promise<T>) =>
  withWorkspace(env.HYPERDRIVE, actor.workspaceId, fn);
