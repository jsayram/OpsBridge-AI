import { Hono } from "hono";
import { requireActor, requireCapability } from "../auth/actor";
import { hashHex } from "../auth/tokens";
import { checkUpload, MAX_UPLOAD_BYTES } from "../ai/upload";
import { withWorkspace } from "../db";
import type { AppEnv } from "../env";
import { ApiError, invalidRequest, notFound } from "../http/errors";
import { log } from "../http/log";
import {
  canonicalId,
  optionalText,
  readStrictJson,
  requireIdempotencyKey,
  requireOneOf,
  requireVersion,
} from "../http/validate";
import {
  attachFixture,
  type Decision,
  decideReview,
  documentDetail,
  listFixtures,
  previewEdits,
  requestReview,
  retryReview,
  reviewDetail,
} from "../repo/aiReviews";
import { commandContext, idempotent } from "../repo/records";

// Mounted at /api/v1. PRD 8.2 document and AI review endpoints (P5).
export const documents = new Hono<AppEnv>();

const FIXTURE_ID = /^fx-[a-z0-9-]{1,40}$/;

// The allowlist a person can attach from. Read-only, the same for every workspace.
documents.get("/fixtures/documents", requireActor, requireCapability("cases:read"), async (c) => {
  const actor = c.get("actor");
  return c.json(await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, listFixtures));
});

// Owner upload, kept only for the PRD security tests (DEC-003: fixtures only). Authorization
// comes before the body is read, the size is capped while reading, and a file that passes every
// byte check is still refused. Nothing is written anywhere.
documents.post(
  "/cases/:id/documents",
  requireActor,
  requireCapability("documents:upload"),
  async (c) => {
    canonicalId(c.req.param("id"));
    const declared = Number(c.req.header("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      throw new ApiError(413, "file_too_large", "That file is too large.");
    }
    const reader = c.req.raw.body?.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_UPLOAD_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ApiError(413, "file_too_large", "That file is too large.");
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    const verdict = checkUpload(c.req.header("content-type"), bytes);
    log({
      level: "info",
      event: "upload_checked",
      requestId: c.get("requestId"),
      outcome: verdict.ok ? "passed_checks" : verdict.code,
    });
    if (!verdict.ok) throw new ApiError(verdict.status, verdict.code, "That file was refused.");
    throw new ApiError(
      409,
      "owner_upload_disabled",
      "Uploads are off. This demo reviews prepared fictional documents only.",
    );
  },
);

documents.post(
  "/cases/:id/documents/from-fixture",
  requireActor,
  requireCapability("documents:attach"),
  async (c) => {
    const actor = c.get("actor");
    const caseId = canonicalId(c.req.param("id"));
    const key = requireIdempotencyKey(c);
    const body = await readStrictJson(c, ["fixtureId"]);
    if (typeof body.fixtureId !== "string" || !FIXTURE_ID.test(body.fixtureId)) {
      throw new ApiError(422, "unknown_fixture", "That fixture isn't on the list.");
    }
    const fixtureId = body.fixtureId;
    const hash = await hashHex({ route: "POST /documents/from-fixture", caseId, fixtureId });
    const out = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) => {
      const ctx = commandContext(db, actor, c.get("requestId"));
      return idempotent(ctx, key, hash, async () => ({
        status: 201,
        body: await attachFixture(ctx, actor.kind === "guest", caseId, fixtureId),
      }));
    });
    if (out.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(out.body as object, 201);
  },
);

documents.get("/documents/:id", requireActor, requireCapability("cases:read"), async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const detail = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    documentDetail(db, actor, id),
  );
  if (!detail) throw notFound();
  return c.json(detail);
});

documents.post(
  "/documents/:id/review",
  requireActor,
  requireCapability("ai:request"),
  async (c) => {
    const actor = c.get("actor");
    const id = canonicalId(c.req.param("id"));
    const body = await readStrictJson(c, ["mode"]);
    const mode =
      body.mode === undefined
        ? "fixture"
        : requireOneOf(body.mode, ["fixture", "live"] as const, "mode");
    if (mode === "live" && !(actor.kind === "owner")) {
      throw new ApiError(403, "forbidden", "Live AI review is for the owner only.");
    }
    const out = await requestReview(c.env, actor, c.get("requestId"), id, { mode });
    return c.json(out, 201);
  },
);

documents.get("/ai-reviews/:id", requireActor, requireCapability("cases:read"), async (c) => {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const detail = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    reviewDetail(db, actor.workspaceId, id),
  );
  if (!detail) throw notFound();
  return c.json(detail);
});

documents.post(
  "/ai-reviews/:id/retry",
  requireActor,
  requireCapability("ai:request"),
  async (c) => {
    const actor = c.get("actor");
    const id = canonicalId(c.req.param("id"));
    return c.json(await retryReview(c.env, actor, c.get("requestId"), id));
  },
);

// Read-only: what an accept with these edits would apply now. Nothing is stored.
documents.post(
  "/ai-reviews/:id/preview",
  requireActor,
  requireCapability("ai:decide"),
  async (c) => {
    const actor = c.get("actor");
    const id = canonicalId(c.req.param("id"));
    const body = await readStrictJson(c, ["edits"]);
    return c.json(
      await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
        previewEdits(db, actor.workspaceId, id, body.edits),
      ),
    );
  },
);

documents.post(
  "/ai-reviews/:id/decision",
  requireActor,
  requireCapability("ai:decide"),
  async (c) => {
    const actor = c.get("actor");
    const id = canonicalId(c.req.param("id"));
    const key = requireIdempotencyKey(c);
    const body = await readStrictJson(c, [
      "decision",
      "version",
      "reason",
      "edits",
      "caseVersion",
      "expectApply",
    ]);
    const expect = body.expectApply;
    if (
      expect !== undefined &&
      (!Array.isArray(expect) ||
        expect.length > 6 ||
        !expect.every((x) => typeof x === "string" && /^[a-z_]{1,40}:(done|flagged)$/.test(x)))
    ) {
      throw invalidRequest("Bad expectApply");
    }
    if ((body.caseVersion === undefined) !== (expect === undefined)) {
      throw invalidRequest("caseVersion and expectApply go together");
    }
    const decision = requireOneOf(
      body.decision,
      ["accept", "accept_with_edits", "reject"] as const,
      "decision",
    );
    if ((decision === "accept_with_edits") !== (body.edits !== undefined)) {
      throw invalidRequest("Edits go with accept_with_edits, and only with it");
    }
    if (decision === "reject" && body.caseVersion !== undefined) {
      throw invalidRequest("A rejection changes nothing on the case");
    }
    const reason = optionalText(body.reason, "Reason", 500);
    const input: Decision = {
      decision,
      version: requireVersion(body.version),
      ...(reason ? { reason } : {}),
      ...(body.edits !== undefined ? { edits: body.edits as Record<string, string | null> } : {}),
      ...(body.caseVersion !== undefined ? { caseVersion: requireVersion(body.caseVersion) } : {}),
      ...(expect !== undefined ? { expectApply: expect as string[] } : {}),
    };
    const hash = await hashHex({ route: "POST /ai-reviews/decision", id, input });
    const out = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) => {
      const ctx = commandContext(db, actor, c.get("requestId"));
      return idempotent(ctx, key, hash, async () => ({
        status: 200,
        body: await decideReview(ctx, id, input),
      }));
    });
    if (out.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(out.body as object, 200);
  },
);
