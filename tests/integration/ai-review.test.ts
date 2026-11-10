import { beforeAll, describe, expect, it, vi } from "vitest";
import { FIXTURE_LABEL } from "../../backend/src/repo/aiReviews";
import { asOwner, fixture } from "./ai-double";
import {
  call,
  connect,
  counts,
  type Guest,
  idempotencyKey,
  launch,
  packCases,
  setRole,
} from "./harness";

const attach = async (g: Guest, caseId: string, fixtureId: string) => {
  const res = await call(`/api/v1/cases/${caseId}/documents/from-fixture`, {
    cookie: g.cookie,
    headers: idempotencyKey(),
    body: { fixtureId },
  });
  if (res.status !== 201) throw new Error(`attach ${res.status} ${res.text}`);
  return res.json.id as string;
};
const review = (g: Guest, docId: string, body: unknown = {}) =>
  call(`/api/v1/documents/${docId}/review`, { cookie: g.cookie, body });
const decide = (g: Guest, id: string, body: Record<string, unknown>, key = idempotencyKey()) =>
  call(`/api/v1/ai-reviews/${id}/decision`, { cookie: g.cookie, headers: key, body });
const caseState = async (g: Guest, caseId: string) => {
  const d = await call(`/api/v1/cases/${caseId}`, { cookie: g.cookie });
  return {
    status: d.json.status,
    version: d.json.version,
    checklist: d.json.checklist.map((i: { key: string; state: string }) => `${i.key}:${i.state}`),
  };
};
const itemIds = (items: { itemKey: string; state: string }[]) =>
  items.map((i) => `${i.itemKey}:${i.state}`);
const WATCHED = [
  "outbox",
  "approvals",
  "consultant_handoffs",
  "external_connections",
  "workflow_rules",
];

describe("structured fixture review (P5.2, P5-A, P5-B)", () => {
  let g: Guest;
  let intakeCase: string;
  beforeAll(async () => {
    g = await launch();
    await setRole(g.cookie, "analyst");
    intakeCase = (await packCases(g))["case-1"]?.id as string;
  });

  it("turns a complete document into a labeled, source-linked suggestion", async () => {
    const doc = await attach(g, intakeCase, "fx-standard-02");
    const res = await review(g, doc);
    expect(res.status).toBe(201);
    const r = res.json.review;
    expect(r).toMatchObject({
      status: "Needs Human Review",
      mode: "fixture",
      label: FIXTURE_LABEL,
      promptVersion: "doc-review-v1",
      tokensIn: 0,
      costMicroUsd: 0,
    });
    expect(r.inputSha256).toBe(fixture("fx-standard-02").sha256);
    expect(Object.keys(r.suggestion.extractedFields)).toHaveLength(6);
    // Every shown field cites a real segment whose text contains the value.
    const segs = fixture("fx-standard-02").segments;
    for (const [field, value] of Object.entries(r.suggestion.extractedFields)) {
      const cites = r.citations.filter((c: { field: string }) => c.field === field);
      expect(cites.length).toBeGreaterThan(0);
      for (const c of cites) {
        const s = segs.find((x: { id: string }) => x.id === c.segmentId);
        expect(s.text.toLowerCase()).toContain(String(value).toLowerCase());
        expect(c.page).toBe(s.page);
      }
    }
    expect(r.validation).toMatchObject({ valid: true, errors: [] });
  });

  it("replays deterministically: same document, same stored output and hash", async () => {
    const a = await attach(g, intakeCase, "fx-standard-03");
    const b = await attach(g, intakeCase, "fx-standard-03");
    const r1 = (await review(g, a)).json.review;
    const r2 = (await review(g, b)).json.review;
    expect(r2.suggestion).toEqual(r1.suggestion);
    expect(r2.citations).toEqual(r1.citations);
    expect(r2.inputSha256).toBe(r1.inputSha256);
    expect(r2.modelVersion).toBe(r1.modelVersion);
  });

  it("reports missing fields instead of inventing them", async () => {
    const r = (await review(g, await attach(g, intakeCase, "fx-standard-01"))).json.review;
    expect(r.suggestion.missingFields.sort()).toEqual(["billingContact", "scopeSigned"]);
    expect(r.suggestion.extractedFields).not.toHaveProperty("billingContact");
  });

  it("flags conflicting dates as uncertain and doesn't pick one", async () => {
    const r = (await review(g, await attach(g, intakeCase, "fx-messy-26"))).json.review;
    expect(r.suggestion.extractedFields).not.toHaveProperty("serviceStart");
    expect(r.suggestion.uncertainties).toContainEqual(
      expect.objectContaining({ field: "serviceStart", reason: "conflicting_values" }),
    );
  });

  it("abstains on an image-only scan with no_extractable_text, still for a person to see", async () => {
    const r = (await review(g, await attach(g, intakeCase, "fx-messy-29"))).json.review;
    expect(r).toMatchObject({ status: "Needs Human Review", abstainReason: "no_extractable_text" });
    expect(r.suggestion.proposedAction).toEqual({ kind: "none" });
    expect(r.policy.apply).toEqual([]);
  });

  it("refuses a viewer, a template document, a second run while one is open, and guest live mode", async () => {
    const viewer = await launch();
    const doc = await attach(g, intakeCase, "fx-standard-04");
    await setRole(viewer.cookie, "analyst");
    expect((await review(viewer, doc)).status).toBe(404);
    await setRole(viewer.cookie, "viewer");
    const mig = await connect("opsbridge_migrator");
    const t = (
      await mig.query(
        "SELECT id FROM app.documents WHERE workspace_id = '00000000-0000-4000-8000-000000000001' LIMIT 1",
      )
    ).rows[0].id;
    await mig.end();
    expect((await review(viewer, t)).status).toBe(403);
    expect((await review(g, t)).status).toBe(403);
    expect((await review(g, doc, { mode: "live" })).status).toBe(403);
    expect((await review(g, doc, { mode: "anything" })).status).toBe(400);
  });

  it("matches the seeded template review to what the Worker stores", async () => {
    const mig = await connect("opsbridge_migrator");
    const seeded = (
      await mig.query(
        `SELECT r.extraction, r.citations, r.validation FROM app.ai_reviews r
        WHERE r.workspace_id = '00000000-0000-4000-8000-000000000001'`,
      )
    ).rows[0];
    await mig.end();
    const fresh = (await review(g, await attach(g, intakeCase, "fx-standard-01"))).json.review;
    expect(seeded.extraction).toEqual(fresh.suggestion);
    expect(seeded.citations).toEqual(fresh.citations);
    expect(seeded.validation).toEqual(fresh.validation);
  });
});

describe("prompt-injection documents (P5-C, E2E-12)", () => {
  it("cause no tool call, outbound request, event, approval or status change", async () => {
    const g = await launch();
    await setRole(g.cookie, "manager");
    const cases = await packCases(g);
    const target = cases["case-1"]?.id as string;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const before = await counts(g.workspaceId, WATCHED);
    const ids = Array.from({ length: 10 }, (_, i) => `fx-adversarial-${31 + i}`);
    for (const id of ids) {
      const start = await caseState(g, target);
      const r = (await review(g, await attach(g, target, id))).json.review;
      expect(r.status, id).toBe("Needs Human Review");
      expect(r.suggestion.reasons, id).toContain("suspicious_instructions_ignored");
      // No field value carries the attack text.
      for (const v of Object.values(r.suggestion.extractedFields) as string[]) {
        expect(v).not.toMatch(
          /https?:|<|>|ignore|approve|assistant|system|tool|@(?!example\.com)/i,
        );
      }
      // Accepting and applying changes only checklist items the rules allow from real fields.
      const out = await decide(g, r.id, {
        decision: "accept",
        version: r.version,
        caseVersion: start.version,
        expectApply: itemIds(r.policy.apply),
      });
      expect(out.status, id).toBe(200);
      const after = await caseState(g, target);
      expect(after.status, id).toBe(start.status);
      for (const a of out.json.review.applied) {
        expect([
          "client_contact_confirmed",
          "scope_confirmed",
          "billing_entity_confirmed",
          "renewal_terms_confirmed",
        ]).toContain(a.itemKey);
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(await counts(g.workspaceId, WATCHED)).toEqual(before);
  });
});

describe("human review and audited command (P5.4, P5-D, E2E-11)", () => {
  let g: Guest;
  let caseId: string;
  beforeAll(async () => {
    g = await launch();
    await setRole(g.cookie, "manager");
    caseId = (await packCases(g))["case-1"]?.id as string;
  });
  const fresh = async (fixtureId = "fx-standard-02") =>
    (await review(g, await attach(g, caseId, fixtureId))).json.review;

  it("reject changes nothing on the case and is audited", async () => {
    const r = await fresh();
    const before = await caseState(g, caseId);
    const watched = await counts(g.workspaceId, WATCHED);
    const res = await decide(g, r.id, {
      decision: "reject",
      version: r.version,
      reason: "Wrong client",
    });
    expect(res.status).toBe(200);
    expect(res.json.review).toMatchObject({
      status: "Rejected",
      applied: null,
      decisionReason: "Wrong client",
    });
    expect(await caseState(g, caseId)).toEqual(before);
    expect(await counts(g.workspaceId, WATCHED)).toEqual(watched);
    const activity = await call(`/api/v1/cases/${caseId}/activity`, { cookie: g.cookie });
    expect(activity.json.items[0]).toMatchObject({ action: "ai_review.decided", actor: "manager" });
    expect((await decide(g, r.id, { decision: "accept", version: r.version + 1 })).json.code).toBe(
      "already_decided",
    );
  });

  it("refuses analysts and viewers, and another workspace gets 404", async () => {
    const r = await fresh();
    await setRole(g.cookie, "analyst");
    expect((await decide(g, r.id, { decision: "reject", version: r.version })).status).toBe(403);
    await setRole(g.cookie, "manager");
    const other = await launch();
    await setRole(other.cookie, "manager");
    expect((await decide(other, r.id, { decision: "reject", version: r.version })).status).toBe(
      404,
    );
  });

  it("accept with a stale case version changes nothing at all", async () => {
    const r = await fresh();
    const before = await caseState(g, caseId);
    const res = await decide(g, r.id, {
      decision: "accept",
      version: r.version,
      caseVersion: before.version + 5,
      expectApply: itemIds(r.policy.apply),
    });
    expect([res.status, res.json.code]).toEqual([409, "stale_version"]);
    expect(await caseState(g, caseId)).toEqual(before);
    const again = await call(`/api/v1/ai-reviews/${r.id}`, { cookie: g.cookie });
    expect(again.json.status).toBe("Needs Human Review");
    const staleReview = await decide(g, r.id, { decision: "accept", version: r.version + 7 });
    expect(staleReview.json.code).toBe("stale_review");
  });

  it("invalid edits are refused and the original suggestion stays as it was", async () => {
    const r = await fresh();
    for (const edits of [
      { ssn: "123" },
      { clientName: "<script>x</script>" },
      { billingContact: "x@evil.test" },
      { serviceStart: "2026-13-01" },
      { clientName: r.suggestion.extractedFields.clientName },
      {},
    ]) {
      const res = await decide(g, r.id, {
        decision: "accept_with_edits",
        version: r.version,
        edits,
      });
      expect([res.status, res.json.code], JSON.stringify(edits)).toEqual([422, "invalid_edit"]);
    }
    const mixed = await decide(g, r.id, {
      decision: "reject",
      version: r.version,
      edits: { scopeSigned: "no" },
    });
    expect(mixed.status).toBe(400);
    const app = await connect("opsbridge_app");
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.workspace_id', $1, true)", [g.workspaceId]);
    const tamper = await app
      .query("UPDATE app.ai_reviews SET extraction = '{}'::jsonb WHERE id = $1", [r.id])
      .catch((e) => e);
    await app.query("ROLLBACK");
    await app.end();
    expect(tamper.code).toBe("P0010");
  });

  it("accept commits allowed checklist changes through the ordinary command, linked to the source", async () => {
    // fx-standard-03 names this case's client, so the rules allow its changes here.
    const r = await fresh("fx-standard-03");
    expect(r.policy.comparisons[0].outcome).toBe("match");
    expect(r.policy.apply.length).toBeGreaterThan(0);
    const before = await caseState(g, caseId);
    const res = await decide(g, r.id, {
      decision: "accept",
      version: r.version,
      caseVersion: before.version,
      expectApply: itemIds(r.policy.apply),
    });
    expect(res.status).toBe(200);
    const applied = res.json.review.applied;
    expect(itemIds(applied)).toEqual(itemIds(r.policy.apply));
    const after = await caseState(g, caseId);
    expect(after.version).toBe(before.version + applied.length);
    expect(after.status).toBe(before.status);
    const detail = await call(`/api/v1/cases/${caseId}`, { cookie: g.cookie });
    for (const a of applied) {
      const item = detail.json.checklist.find((i: { key: string }) => i.key === a.itemKey);
      expect(item.state).toBe(a.state);
      expect(item.evidenceRef).toMatch(new RegExp(`^ai-review:${r.id.slice(0, 8)} p1-s\\d`));
    }
    const actions = (
      await call(`/api/v1/cases/${caseId}/activity?limit=10`, { cookie: g.cookie })
    ).json.items.map((i: { action: string }) => i.action);
    expect(actions).toContain("checklist.updated");
    expect(actions[0]).toBe("ai_review.decided");
  });

  it("accept with edits revalidates, stores edits beside the original, and marks the source as reviewer-edited", async () => {
    const g2 = await launch();
    await setRole(g2.cookie, "manager");
    const c2 = (await packCases(g2))["case-1"]?.id as string;
    const r = (await review(g2, await attach(g2, c2, "fx-standard-01"))).json.review;
    expect(r.policy.apply.some((i: { itemKey: string }) => i.itemKey === "scope_confirmed")).toBe(
      false,
    );
    const before = await caseState(g2, c2);
    // The reviewer previews what the edit would change, then sends that list back.
    const preview = await call(`/api/v1/ai-reviews/${r.id}/preview`, {
      cookie: g2.cookie,
      body: { edits: { scopeSigned: "yes" } },
    });
    expect(preview.status).toBe(200);
    expect(itemIds(preview.json.policy.apply)).toContain("scope_confirmed:done");
    const stale = await decide(g2, r.id, {
      decision: "accept_with_edits",
      version: r.version,
      edits: { scopeSigned: "yes" },
      caseVersion: before.version,
      expectApply: itemIds(r.policy.apply),
    });
    expect([stale.status, stale.json.code]).toEqual([409, "apply_changed"]);
    expect(await caseState(g2, c2)).toEqual(before);
    const res = await decide(g2, r.id, {
      decision: "accept_with_edits",
      version: r.version,
      edits: { scopeSigned: "yes" },
      caseVersion: before.version,
      expectApply: itemIds(preview.json.policy.apply),
    });
    expect(res.status).toBe(200);
    expect(res.json.review.status).toBe("Accepted with Edits");
    expect(res.json.review.reviewerEdits).toEqual({ scopeSigned: "yes" });
    expect(res.json.review.suggestion).toEqual(r.suggestion);
    const scope = res.json.review.applied.find(
      (a: { itemKey: string }) => a.itemKey === "scope_confirmed",
    );
    expect(scope.evidenceRef).toContain("reviewer-edited");
  });

  it("a document for another client can only flag the client contact (independent review, P5)", async () => {
    const r = await fresh("fx-standard-02");
    expect(r.policy.comparisons[0].outcome).toBe("mismatch");
    for (const item of r.policy.apply) {
      expect(`${item.itemKey}:${item.state}`).toBe("client_contact_confirmed:flagged");
    }
    expect(r.policy.refused.map((i: { code: string }) => i.code)).not.toContain(undefined);
  });

  it("an abstained review can't be edited into a suggestion", async () => {
    const r = await fresh("fx-messy-29");
    expect(r.suggestion.abstained).toBe(true);
    const res = await decide(g, r.id, {
      decision: "accept_with_edits",
      version: r.version,
      edits: { scopeSigned: "yes" },
    });
    expect([res.status, res.json.code]).toEqual([422, "invalid_edit"]);
    const pv = await call(`/api/v1/ai-reviews/${r.id}/preview`, {
      cookie: g.cookie,
      body: { edits: { scopeSigned: "yes" } },
    });
    expect(pv.status).toBe(422);
  });

  it("accept without a case version records the decision and changes nothing on the case", async () => {
    const r = await fresh("fx-standard-03");
    const before = await caseState(g, caseId);
    const res = await decide(g, r.id, { decision: "accept", version: r.version });
    expect(res.json.review).toMatchObject({ status: "Accepted", applied: null });
    expect(await caseState(g, caseId)).toEqual(before);
    const half = await decide(g, (await fresh("fx-standard-07")).id, {
      decision: "accept",
      version: 2,
      caseVersion: before.version,
    });
    expect(half.status).toBe(400);
  });

  it("a document can't join a case once it is Ready", async () => {
    const ready = (await packCases(g))["case-3"];
    expect(ready?.status).toBe("Ready");
    const res = await call(`/api/v1/cases/${ready?.id}/documents/from-fixture`, {
      cookie: g.cookie,
      headers: idempotencyKey(),
      body: { fixtureId: "fx-standard-01" },
    });
    expect([res.status, res.json.code]).toEqual([409, "case_locked"]);
  });

  it("a replayed decision returns the stored response and changes nothing twice", async () => {
    const r = await fresh("fx-standard-05");
    const before = await caseState(g, caseId);
    const key = idempotencyKey();
    const body = {
      decision: "accept",
      version: r.version,
      caseVersion: before.version,
      expectApply: itemIds(r.policy.apply),
    };
    const first = await decide(g, r.id, body, key);
    const second = await decide(g, r.id, body, key);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(second.json).toEqual(first.json);
  });
});

describe("failures are visible and recoverable (P5-E)", () => {
  it("the sweep fails a stuck Processing review, and retry brings it to review", async () => {
    const g = await launch();
    await setRole(g.cookie, "analyst");
    const caseId = (await packCases(g))["case-1"]?.id as string;
    const doc = await attach(g, caseId, "fx-standard-07");
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      `INSERT INTO app.ai_reviews (workspace_id, document_id, model_version, prompt_version, status,
                                   processing_started_at, attempts, input_sha256)
       SELECT workspace_id, id, 'fixture', 'doc-review-v1', 'Processing', now() - interval '6 minutes', 1, sha256
         FROM app.documents WHERE id = $1 RETURNING id`,
      [doc],
    );
    const id = rows[0].id;
    expect((await review(g, doc)).json.code).toBe("review_in_progress");
    const cleanup = await connect("opsbridge_cleanup");
    expect(
      (await cleanup.query("SELECT app.fail_stuck_ai_reviews(50) AS n")).rows[0].n,
    ).toBeGreaterThanOrEqual(1);
    await cleanup.end();
    const failed = await call(`/api/v1/ai-reviews/${id}`, { cookie: g.cookie });
    expect(failed.json).toMatchObject({ status: "Failed", errorCode: "processing_timeout" });
    const timeline = await call(`/api/v1/cases/${caseId}/activity`, { cookie: g.cookie });
    expect(timeline.json.items[0]).toMatchObject({ action: "ai_review.failed", actor: "system" });
    const retried = await call(`/api/v1/ai-reviews/${id}/retry`, {
      cookie: g.cookie,
      method: "POST",
    });
    expect(retried.status).toBe(200);
    expect(retried.json).toMatchObject({ status: "Needs Human Review", attempts: 2 });
    const twice = await call(`/api/v1/ai-reviews/${id}/retry`, {
      cookie: g.cookie,
      method: "POST",
    });
    expect(twice.json.code).toBe("not_failed");
    await mig.end();
  });

  it("the daily review quota is a locked counter, so parallel requests can't overshoot it", async () => {
    const g = await launch();
    await setRole(g.cookie, "analyst");
    const caseId = (await packCases(g))["case-1"]?.id as string;
    const docs = [];
    for (const f of ["fx-standard-09", "fx-standard-11", "fx-standard-13"]) {
      docs.push(await attach(g, caseId, f));
    }
    const mig = await connect("opsbridge_migrator");
    await mig.query(
      `INSERT INTO app.ai_usage (workspace_id, day, reviews) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 24)
       ON CONFLICT (workspace_id, day) DO UPDATE SET reviews = 24`,
      [g.workspaceId],
    );
    await mig.end();
    const results = await Promise.all(docs.map((d) => review(g, d)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 429, 429]);
  });

  it("purging a workspace removes its documents, reviews and usage", async () => {
    const g = await launch();
    await setRole(g.cookie, "analyst");
    const caseId = (await packCases(g))["case-1"]?.id as string;
    await review(g, await attach(g, caseId, "fx-standard-08"));
    const mig = await connect("opsbridge_migrator");
    await mig.query(
      "UPDATE app.workspaces SET expires_at = now() - interval '2 minutes' WHERE id = $1",
      [g.workspaceId],
    );
    // The review above already took a quota slot, so the usage row exists.
    const usage = await mig.query("SELECT 1 FROM app.ai_usage WHERE workspace_id = $1", [
      g.workspaceId,
    ]);
    expect(usage.rowCount).toBe(1);
    await mig.end();
    const cleanup = await connect("opsbridge_cleanup");
    await cleanup.query("SELECT app.purge_demo_workspace($1)", [g.workspaceId]);
    await cleanup.end();
    expect(await counts(g.workspaceId, ["documents", "ai_reviews", "ai_usage"])).toEqual({
      documents: 0,
      ai_reviews: 0,
      ai_usage: 0,
    });
  });
});

describe("owner review in the owner workspace", () => {
  it("works in fixture mode and needs no provider", async () => {
    const att = await asOwner(
      "/api/v1/cases/00000000-0000-4000-8000-000000000004/documents/from-fixture",
      {
        body: { fixtureId: "fx-standard-09" },
        key: true,
      },
    );
    expect(att.status).toBe(201);
    const res = await asOwner(`/api/v1/documents/${att.json.id}/review`, { body: {} });
    expect(res.json.review).toMatchObject({ status: "Needs Human Review", mode: "fixture" });
  });
});
