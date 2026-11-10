// P8.1: the guided checklist reads every step back from the visitor's own records. A step can't be
// marked done by the page, by the seeded pack, or by another workspace, and a reset starts over.
import { describe, expect, it } from "vitest";
import {
  call,
  type Guest,
  idempotencyKey,
  launch,
  mintOwnerToken,
  ownerEnv,
  packCases,
  type Source,
  setRole,
  sources,
  sync,
} from "./harness";

const progress = async (g: Guest) => {
  const res = await call("/api/v1/demo/progress", { cookie: g.cookie });
  expect(res.status).toBe(200);
  return res.json as {
    complete: boolean;
    elapsedSeconds: number | null;
    startedAt: string;
    steps: { key: string; done: boolean; completedAt: string | null }[];
    recap: Record<string, unknown>;
  };
};
const doneKeys = async (g: Guest) =>
  (await progress(g)).steps.filter((s) => s.done).map((s) => s.key);

async function runAllSteps(g: Guest) {
  await setRole(g.cookie, "manager");
  const pack = await packCases(g);
  const customers = await call("/api/v1/customers", { cookie: g.cookie });
  const made = await call("/api/v1/cases", {
    cookie: g.cookie,
    headers: idempotencyKey(),
    body: {
      title: "Guided demo case",
      customerId: customers.json.items[0].id,
      caseType: "Billing",
    },
  });
  expect(made.status).toBe(201);
  const list = await sources(g.cookie);
  const s = await sync(g.cookie, (list.erp_simulator as Source).id, {
    scenario: "renamed_customer",
  });
  expect(s.status).toBeLessThan(300);
  const intake = pack["case-1"]?.id as string;
  const doc = await call(`/api/v1/cases/${intake}/documents/from-fixture`, {
    cookie: g.cookie,
    headers: idempotencyKey(),
    body: { fixtureId: "fx-standard-02" },
  });
  const review = await call(`/api/v1/documents/${doc.json.id}/review`, {
    cookie: g.cookie,
    body: {},
  });
  const r = review.json.review;
  const decided = await call(`/api/v1/ai-reviews/${r.id}/decision`, {
    cookie: g.cookie,
    headers: idempotencyKey(),
    body: { decision: "reject", version: r.version, reason: "Guided demo" },
  });
  expect(decided.status).toBe(200);
  const ready = pack["case-3"] as { id: string; version: number };
  const detail = await call(`/api/v1/cases/${ready.id}`, { cookie: g.cookie });
  const approved = await call(`/api/v1/approvals/${detail.json.approval.id}/decision`, {
    cookie: g.cookie,
    headers: idempotencyKey(),
    body: { decision: "approve", caseVersion: detail.json.version },
  });
  expect(approved.status).toBe(200);
}

describe("guided demo progress (P8.1)", () => {
  it("a fresh workspace has only the launch step done, whatever the pack holds", async () => {
    const g = await launch();
    const p = await progress(g);
    expect(p.steps.map((s) => [s.key, s.done])).toEqual([
      ["workspace_launched", true],
      ["case_created", false],
      ["mismatch_detected", false],
      ["document_reviewed", false],
      ["resolution_approved", false],
    ]);
    expect(p.complete).toBe(false);
    expect(p.elapsedSeconds).toBeNull();
    expect(p.recap).toMatchObject({
      casesCreated: 0,
      findingsOpened: 0,
      auditEventsWritten: 0,
      sources: "Simulated",
      aiReview: "Deterministic fixture",
      delivery: "Simulated",
    });
  });

  it("each step turns done only after the visitor's own action, and the recap counts them", async () => {
    const g = await launch();
    await runAllSteps(g);
    const p = await progress(g);
    expect(p.steps.every((s) => s.done)).toBe(true);
    expect(p.complete).toBe(true);
    expect(p.elapsedSeconds).toBeGreaterThanOrEqual(0);
    expect(p.recap).toMatchObject({ casesCreated: 1, reviewsDecided: 1, approvals: 1 });
    expect(p.recap.findingsOpened as number).toBeGreaterThan(0);
    expect(p.recap.automationRuns as number).toBeGreaterThan(0);
    // A guest's runs never claim delivery: everything recorded is Simulated or still pending.
    expect(p.recap.auditEventsWritten as number).toBeGreaterThanOrEqual(4);
  });

  it("another visitor's progress never shows up, and a reset starts the checklist over", async () => {
    const a = await launch();
    const b = await launch();
    await runAllSteps(a);
    expect(await doneKeys(b)).toEqual(["workspace_launched"]);
    const reset = await call("/api/v1/demo/reset", { method: "POST", cookie: a.cookie });
    expect(reset.status).toBe(200);
    const after = { ...a, cookie: reset.headers.get("set-cookie")?.split(";")[0] ?? "" };
    expect(await doneKeys(after)).toEqual(["workspace_launched"]);
  });

  it("a rejected approval doesn't count as approving a resolution", async () => {
    const g = await launch();
    await setRole(g.cookie, "manager");
    const ready = (await packCases(g))["case-3"] as { id: string };
    const detail = await call(`/api/v1/cases/${ready.id}`, { cookie: g.cookie });
    const res = await call(`/api/v1/approvals/${detail.json.approval.id}/decision`, {
      cookie: g.cookie,
      headers: idempotencyKey(),
      body: { decision: "reject", caseVersion: detail.json.version, reason: "Not yet" },
    });
    expect(res.status).toBe(200);
    expect(await doneKeys(g)).toEqual(["workspace_launched"]);
  });

  it("refuses no session, and an owner gets 404", async () => {
    expect((await call("/api/v1/demo/progress")).status).toBe(401);
    const owner = await call("/api/v1/demo/progress", {
      env: ownerEnv,
      headers: { "cf-access-jwt-assertion": await mintOwnerToken() },
    });
    expect(owner.status).toBe(404);
  });
});
