import { beforeAll, describe, expect, it } from "vitest";
import { call, connect, type Guest, launch, packCases, setRole } from "./harness";

const patch = (cookie: string, id: string, body: unknown) =>
  call(`/api/v1/cases/${id}`, { method: "PATCH", cookie, body });

const checklist = async (cookie: string, id: string) =>
  (await call(`/api/v1/cases/${id}`, { cookie })).json.checklist as {
    id: string;
    key: string;
    required: boolean;
    state: string;
    version: number;
  }[];

const setItem = (
  cookie: string,
  caseId: string,
  item: { id: string; version: number },
  state: string,
) =>
  call(`/api/v1/cases/${caseId}/checklist/${item.id}`, {
    method: "PATCH",
    cookie,
    body: { state, version: item.version },
  });

const finishRequired = async (cookie: string, id: string, state = "done") => {
  for (const item of await checklist(cookie, id)) {
    if (item.required) await setItem(cookie, id, item, state);
  }
};

const events = async (g: Guest) => {
  const mig = await connect("opsbridge_migrator");
  const { rows } = await mig.query(
    "SELECT event_type, idempotency_key, payload FROM app.outbox WHERE workspace_id = $1 ORDER BY created_at, id",
    [g.workspaceId],
  );
  await mig.end();
  return rows;
};

describe("P2.3 transitions through the API", () => {
  it("runs the whole path with the right role at each step", async () => {
    const g = await launch();
    const id = (await packCases(g))["case-1"]?.id as string;

    await finishRequired(g.cookie, id);
    const review = await patch(g.cookie, id, { status: "Needs Review", version: 1 });
    expect(review.status).toBe(200);

    expect((await patch(g.cookie, id, { status: "Ready", version: 2 })).status).toBe(403);
    await setRole(g.cookie, "manager");
    const ready = await patch(g.cookie, id, { status: "Ready", version: 2 });
    expect(ready.status).toBe(200);

    const detail = await call(`/api/v1/cases/${id}`, { cookie: g.cookie });
    expect(detail.json.approval.status).toBe("pending");

    const returned = await patch(g.cookie, id, {
      status: "Needs Review",
      version: 3,
      reason: "Missing signature",
    });
    expect(returned.status).toBe(200);
    const withdrawn = await call(`/api/v1/cases/${id}`, { cookie: g.cookie });
    expect(withdrawn.json.approval.status).toBe("withdrawn");

    const types = (await events(g)).map((e) => [e.event_type, e.payload.data.reason]);
    expect(types).toEqual([
      ["case.needs_review", "intake"],
      ["case.needs_review", "returned"],
    ]);
  });

  it("every illegal move is a typed 409 and changes nothing", async () => {
    const g = await launch();
    await setRole(g.cookie, "manager");
    const pack = await packCases(g);
    const cases = [
      ["case-1", "Ready"],
      ["case-1", "Approved"],
      ["case-1", "Closed"],
      ["case-2", "Approved"],
      ["case-2", "Closed"],
      ["case-3", "Closed"],
      ["case-3", "Draft"],
      ["case-3", "Intake"],
      ["case-2", "Draft"],
    ] as const;
    for (const [key, status] of cases) {
      const target = pack[key];
      const res = await patch(g.cookie, target?.id as string, {
        status,
        version: target?.version,
      });
      expect(res.status, `${key} to ${status}`).toBe(409);
      expect(res.json.code, `${key} to ${status}`).toBe("invalid_transition");
    }
    for (const [key, target] of Object.entries(await packCases(g))) {
      expect(target.version, key).toBe(1);
      expect(target.status).toBe(pack[key]?.status);
    }
    expect(await events(g)).toEqual([]);
  });

  it("PATCH can never reach Approved, even for a reviewer on a Ready case", async () => {
    const g = await launch();
    await setRole(g.cookie, "manager");
    const c = (await packCases(g))["case-3"];
    const res = await patch(g.cookie, c?.id as string, { status: "Approved", version: 1 });
    expect(res.status).toBe(409);
    expect(res.json.message).toContain("approval");
  });

  it("missing reason on a return is a 400", async () => {
    const g = await launch();
    await setRole(g.cookie, "manager");
    const c = (await packCases(g))["case-3"];
    const res = await patch(g.cookie, c?.id as string, { status: "Needs Review", version: 1 });
    expect(res.status).toBe(400);
  });

  it("required checklist items gate Needs Review and Ready separately", async () => {
    const g = await launch();
    const pack = await packCases(g);
    const id = pack["case-1"]?.id as string;
    const blocked = await patch(g.cookie, id, { status: "Needs Review", version: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe("checklist_incomplete");

    await finishRequired(g.cookie, id, "flagged");
    const flaggedPasses = await patch(g.cookie, id, { status: "Needs Review", version: 1 });
    expect(flaggedPasses.status).toBe(200);

    await setRole(g.cookie, "manager");
    const flaggedStops = await patch(g.cookie, id, { status: "Ready", version: 2 });
    expect(flaggedStops.status).toBe(409);
    expect(flaggedStops.json.code).toBe("checklist_incomplete");

    await finishRequired(g.cookie, id);
    expect((await patch(g.cookie, id, { status: "Ready", version: 2 })).status).toBe(200);
  });

  it("an optional item never blocks", async () => {
    const g = await launch();
    const id = (await packCases(g))["case-1"]?.id as string;
    await finishRequired(g.cookie, id);
    const items = await checklist(g.cookie, id);
    expect(items.find((i) => !i.required)?.state).toBe("open");
    expect((await patch(g.cookie, id, { status: "Needs Review", version: 1 })).status).toBe(200);
  });

  it("checklist updates are versioned, audited and locked once a case is Ready", async () => {
    const g = await launch();
    const pack = await packCases(g);
    const id = pack["case-2"]?.id as string;
    const [item] = await checklist(g.cookie, id);
    if (!item) throw new Error("no item");
    expect((await setItem(g.cookie, id, item, "open")).status).toBe(200);
    const stale = await setItem(g.cookie, id, item, "done");
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("stale_version");

    const unknown = await call(
      `/api/v1/cases/${id}/checklist/11111111-1111-4111-8111-111111111111`,
      { method: "PATCH", cookie: g.cookie, body: { state: "done", version: 1 } },
    );
    expect(unknown.status).toBe(404);

    const other = pack["case-1"]?.id as string;
    const swapped = await setItem(g.cookie, other, item, "done");
    expect(swapped.status).toBe(404);

    const bad = await setItem(g.cookie, id, { ...item, version: 2 }, "skipped");
    expect(bad.status).toBe(400);

    const ready = pack["case-3"]?.id as string;
    const [readyItem] = await checklist(g.cookie, ready);
    if (!readyItem) throw new Error("no item");
    const locked = await setItem(g.cookie, ready, readyItem, "open");
    expect(locked.status).toBe(409);
    expect(locked.json.code).toBe("checklist_locked");

    const activity = await call(`/api/v1/cases/${id}/activity`, { cookie: g.cookie });
    expect(activity.json.items[0].action).toBe("checklist.updated");
  });

  it("a checklist change can't slip past a transition running at the same moment", async () => {
    for (let round = 0; round < 10; round++) {
      const g = await launch();
      await setRole(g.cookie, "manager");
      const id = (await packCases(g))["case-2"]?.id as string;
      const items = await checklist(g.cookie, id);
      await finishRequired(g.cookie, id);
      const fresh = (await checklist(g.cookie, id)).find((i) => i.required);
      if (!fresh || !items.length) throw new Error("no item");
      const [move, flip] = await Promise.all([
        patch(g.cookie, id, { status: "Ready", version: 1 }),
        setItem(g.cookie, id, fresh, "open"),
      ]);
      const detail = await call(`/api/v1/cases/${id}`, { cookie: g.cookie });
      const required = detail.json.checklist.filter((i: { required: boolean }) => i.required);
      if (detail.json.status === "Ready") {
        expect(required.every((i: { state: string }) => i.state !== "open")).toBe(true);
        expect(flip.status).toBe(409);
      } else {
        expect(move.status).toBe(409);
      }
    }
  });

  it("reopen: reviewer only, reason and version required, new event and new approval later", async () => {
    const g = await launch();
    await setRole(g.cookie, "manager");
    const c = (await packCases(g))["case-3"];
    const id = c?.id as string;
    const detail = await call(`/api/v1/cases/${id}`, { cookie: g.cookie });
    const approve = await call(`/api/v1/approvals/${detail.json.approval.id}/decision`, {
      method: "POST",
      cookie: g.cookie,
      headers: { "idempotency-key": `reopen-test-${id}` },
      body: { decision: "approve", caseVersion: 1 },
    });
    expect(approve.status).toBe(200);
    const closed = await patch(g.cookie, id, { status: "Closed", version: 2 });
    expect(closed.status).toBe(200);
    expect((await patch(g.cookie, id, { title: "x", version: 3 })).status).toBe(409);
    expect(
      (await patch(g.cookie, id, { status: "Needs Review", version: 3, reason: "x" })).status,
    ).toBe(409);

    const reopen = (body: unknown, cookie = g.cookie) =>
      call(`/api/v1/cases/${id}/reopen`, { method: "POST", cookie, body });
    expect((await reopen({ reason: "", version: 3 })).status).toBe(400);
    expect((await reopen({ reason: "New evidence", version: 2 })).status).toBe(409);
    await setRole(g.cookie, "analyst");
    expect((await reopen({ reason: "New evidence", version: 3 })).status).toBe(403);
    await setRole(g.cookie, "manager");
    const ok = await reopen({ reason: "New evidence", version: 3 });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("Needs Review");
    expect((await reopen({ reason: "Again", version: 4 })).status).toBe(409);

    const again = await patch(g.cookie, id, { status: "Ready", version: 4 });
    expect(again.status).toBe(200);
    const latest = await call(`/api/v1/cases/${id}`, { cookie: g.cookie });
    expect(latest.json.approval.status).toBe("pending");
    expect(latest.json.approval.id).not.toBe(detail.json.approval.id);

    const reasons = (await events(g))
      .filter((e) => e.event_type === "case.needs_review")
      .map((e) => e.payload.data.reason);
    expect(reasons).toEqual(["reopened"]);
  });
});

describe("P2.3 handoffs, JOB-TEST-02", () => {
  let g: Guest;
  let id: string;
  let people: { id: string; name: string; team: string; canReceiveCases: boolean }[];

  const handoff = (body: unknown, cookie = g.cookie, caseId = id) =>
    call(`/api/v1/cases/${caseId}/handoffs`, { method: "POST", cookie, body });

  beforeAll(async () => {
    g = await launch();
    id = (await packCases(g))["case-2"]?.id as string;
    people = (await call("/api/v1/assignees", { cookie: g.cookie })).json.items;
  });

  it("hands over with a flagged item: assignment, due date, history and audit all persist", async () => {
    const before = await call(`/api/v1/cases/${id}`, { cookie: g.cookie });
    expect(before.json.checklist.some((i: { state: string }) => i.state === "flagged")).toBe(true);
    const to = people.find((p) => p.canReceiveCases && p.id !== before.json.assigneeId);
    const res = await handoff({
      toAssigneeId: to?.id,
      reason: "Going on leave",
      dueAt: "2030-02-01T00:00:00Z",
      expectedCaseVersion: 1,
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ assigneeId: to?.id, queue: to?.team, version: 2 });
    const after = await call(`/api/v1/cases/${id}`, { cookie: g.cookie });
    expect(after.json.dueAt).toBe("2030-02-01T00:00:00.000Z");
    expect(after.json.handoffs).toHaveLength(1);
    expect(after.json.handoffs[0]).toMatchObject({
      toAssignee: to?.name,
      reason: "Going on leave",
      openRequired: 1,
    });
    const activity = await call(`/api/v1/cases/${id}/activity`, { cookie: g.cookie });
    expect(activity.json.items[0].action).toBe("case.handoff");
  });

  it("a stale handoff fails and leaves no history", async () => {
    const stale = await handoff({
      toQueue: "Field Services",
      reason: "Late",
      expectedCaseVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("stale_version");
    const after = await call(`/api/v1/cases/${id}`, { cookie: g.cookie });
    expect(after.json.handoffs).toHaveLength(1);
  });

  it("an observer, another workspace's person and a random ID all get the same refusal", async () => {
    const observer = people.find((p) => !p.canReceiveCases);
    const other = await launch();
    const stranger = (await call("/api/v1/assignees", { cookie: other.cookie })).json.items[0];
    const bodies = [];
    for (const target of [observer?.id, stranger.id, "11111111-1111-4111-8111-111111111111"]) {
      const res = await handoff({ toAssigneeId: target, reason: "x", expectedCaseVersion: 2 });
      expect(res.status).toBe(403);
      expect(res.json.code).toBe("unauthorized_assignee");
      const { requestId: _drop, ...rest } = res.json;
      bodies.push(rest);
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    const after = await call(`/api/v1/cases/${id}`, { cookie: g.cookie });
    expect(after.json.version).toBe(2);
  });

  it("moves to a queue, clears the assignee, and refuses a no-op", async () => {
    const res = await handoff({
      toQueue: "Field Services",
      reason: "Back to the pool",
      expectedCaseVersion: 2,
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ assigneeId: null, queue: "Field Services" });
    const noop = await handoff({
      toQueue: "Field Services",
      reason: "Same",
      expectedCaseVersion: 3,
    });
    expect(noop.status).toBe(400);
  });

  it("validates its body and role", async () => {
    expect((await handoff({ reason: "x", expectedCaseVersion: 3 })).status).toBe(400);
    expect(
      (
        await handoff({
          toQueue: "Seasonal Staffing",
          toAssigneeId: people[0]?.id,
          reason: "x",
          expectedCaseVersion: 3,
        })
      ).status,
    ).toBe(400);
    expect(
      (await handoff({ toQueue: "Seasonal Staffing", reason: "", expectedCaseVersion: 3 })).status,
    ).toBe(400);
    expect(
      (
        await handoff({
          toQueue: "Seasonal Staffing",
          reason: "x",
          expectedCaseVersion: 3,
          extra: 1,
        })
      ).status,
    ).toBe(400);
    await setRole(g.cookie, "viewer");
    const denied = await handoff({
      toQueue: "Seasonal Staffing",
      reason: "x",
      expectedCaseVersion: 3,
    });
    expect(denied.status).toBe(403);
    await setRole(g.cookie, "analyst");
  });

  it("a closed case can't be handed off", async () => {
    const h = await launch();
    await setRole(h.cookie, "manager");
    const c = (await packCases(h))["case-3"];
    const cid = c?.id as string;
    const d = await call(`/api/v1/cases/${cid}`, { cookie: h.cookie });
    await call(`/api/v1/approvals/${d.json.approval.id}/decision`, {
      method: "POST",
      cookie: h.cookie,
      headers: { "idempotency-key": `closed-handoff-${cid}` },
      body: { decision: "approve", caseVersion: 1 },
    });
    await patch(h.cookie, cid, { status: "Closed", version: 2 });
    const res = await handoff(
      { toQueue: "Field Services", reason: "x", expectedCaseVersion: 3 },
      h.cookie,
      cid,
    );
    expect(res.status).toBe(409);
  });
});
