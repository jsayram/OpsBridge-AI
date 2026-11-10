import { beforeAll, describe, expect, it } from "vitest";
import {
  call,
  connect,
  counts,
  type Guest,
  idempotencyKey,
  launch,
  mintOwnerToken,
  ownerEnv,
  packCases,
  setRole,
} from "./harness";

const customerOf = async (cookie: string) =>
  (await call("/api/v1/customers", { cookie })).json.items[0].id;

const newCase = (cookie: string, customerId: string, extra: Record<string, unknown> = {}) =>
  call("/api/v1/cases", {
    method: "POST",
    cookie,
    headers: idempotencyKey(),
    body: { title: "New case", customerId, caseType: "Billing", ...extra },
  });

describe("P2.2 create", () => {
  let A: Guest;
  let customer: string;

  beforeAll(async () => {
    A = await launch();
    customer = await customerOf(A.cookie);
  });

  it("creates in Intake with its checklist, audit row and one case.created event", async () => {
    const res = await newCase(A.cookie, customer, { dueAt: "2030-01-01T00:00:00Z" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ status: "Intake", version: 1, readOnly: false });
    const mig = await connect("opsbridge_migrator");
    const audit = await mig.query(
      "SELECT action, actor_role, request_id FROM app.audit_events WHERE workspace_id = $1 AND target = $2",
      [A.workspaceId, res.json.id],
    );
    expect(audit.rows).toEqual([
      {
        action: "case.created",
        actor_role: "analyst",
        request_id: res.headers.get("x-request-id"),
      },
    ]);
    const events = await mig.query(
      "SELECT event_type, idempotency_key, payload FROM app.outbox WHERE workspace_id = $1 AND idempotency_key = $2",
      [A.workspaceId, `case:${res.json.id}:created`],
    );
    await mig.end();
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload.data.caseType).toBe("Billing");
    expect(JSON.stringify(events.rows[0].payload)).not.toContain(res.json.id);
    const detail = await call(`/api/v1/cases/${res.json.id}`, { cookie: A.cookie });
    expect(detail.json.checklist.map((i: { key: string }) => i.key)).toEqual([
      "client_contact_confirmed",
      "scope_confirmed",
      "billing_entity_confirmed",
    ]);
  });

  it("E2E-05 same key twice is one case and one event, concurrently too", async () => {
    const before = await counts(A.workspaceId, ["cases", "outbox"]);
    const headers = idempotencyKey();
    const body = { title: "Once only", customerId: customer, caseType: "Renewal" };
    const post = () => call("/api/v1/cases", { method: "POST", cookie: A.cookie, headers, body });
    const results = await Promise.all([post(), post(), post()]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.json.id)).size).toBe(1);
    expect(results.filter((r) => r.headers.get("idempotency-replayed")).length).toBe(2);
    const later = await post();
    expect(later.json.id).toBe(results[0]?.json.id);
    const after = await counts(A.workspaceId, ["cases", "outbox"]);
    expect(after).toEqual({ cases: (before.cases ?? 0) + 1, outbox: (before.outbox ?? 0) + 1 });
  });

  it("same key with a different body is a 409, and a failed command leaves no key", async () => {
    const headers = idempotencyKey();
    const post = (title: string) =>
      call("/api/v1/cases", {
        method: "POST",
        cookie: A.cookie,
        headers,
        body: { title, customerId: customer, caseType: "Renewal" },
      });
    expect((await post("First")).status).toBe(201);
    const other = await post("Second");
    expect(other.status).toBe(409);
    expect(other.json.code).toBe("idempotency_conflict");

    const retry = idempotencyKey();
    const bad = {
      title: "x",
      customerId: "11111111-1111-4111-8111-111111111111",
      caseType: "Renewal",
    };
    const refused = await call("/api/v1/cases", {
      method: "POST",
      cookie: A.cookie,
      headers: retry,
      body: bad,
    });
    expect(refused.status).toBe(400);
    const works = await call("/api/v1/cases", {
      method: "POST",
      cookie: A.cookie,
      headers: retry,
      body: { ...bad, customerId: customer },
    });
    expect(works.status).toBe(201);
  });

  it("needs an idempotency key, and rejects a bad one", async () => {
    const body = { title: "x", customerId: customer, caseType: "Billing" };
    const none = await call("/api/v1/cases", { method: "POST", cookie: A.cookie, body });
    expect(none.status).toBe(400);
    const short = await call("/api/v1/cases", {
      method: "POST",
      cookie: A.cookie,
      headers: { "idempotency-key": "short" },
      body,
    });
    expect(short.status).toBe(400);
  });

  it("mass assignment: privileged fields are refused, not ignored", async () => {
    for (const extra of [
      { status: "Approved" },
      { workspaceId: A.workspaceId },
      { version: 9 },
      { assigneeId: "11111111-1111-4111-8111-111111111111" },
      { readOnly: true },
    ]) {
      const res = await newCase(A.cookie, customer, extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it("validates each field", async () => {
    for (const body of [
      { title: "", customerId: customer, caseType: "Billing" },
      { title: "x", customerId: "nope", caseType: "Billing" },
      { title: "x", customerId: customer, caseType: "Made up" },
      { title: "x", customerId: customer, caseType: "Billing", dueAt: "soon" },
      { title: "x", customerId: customer, caseType: "Billing", queue: "Nowhere" },
    ]) {
      const res = await call("/api/v1/cases", {
        method: "POST",
        cookie: A.cookie,
        headers: idempotencyKey(),
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("a guest can't create a case against another workspace's or the template's customer", async () => {
    const B = await launch();
    const theirs = await customerOf(B.cookie);
    expect((await newCase(A.cookie, theirs)).status).toBe(400);
    const mig = await connect("opsbridge_migrator");
    const tpl = await mig.query(
      "SELECT c.id FROM app.customers c JOIN app.workspaces w ON w.id = c.workspace_id WHERE w.mode = 'template' LIMIT 1",
    );
    await mig.end();
    expect((await newCase(A.cookie, tpl.rows[0].id)).status).toBe(400);
  });

  it("viewer can't create or edit, and gets 403 before any work", async () => {
    const g = await launch();
    await setRole(g.cookie, "viewer");
    const c = await customerOf(g.cookie);
    expect((await newCase(g.cookie, c)).status).toBe(403);
    const before = await counts(g.workspaceId, ["cases", "audit_events"]);
    const target = (await packCases(g))["case-1"];
    const patch = await call(`/api/v1/cases/${target?.id}`, {
      method: "PATCH",
      cookie: g.cookie,
      body: { title: "No", version: 1 },
    });
    expect(patch.status).toBe(403);
    expect(await counts(g.workspaceId, ["cases", "audit_events"])).toEqual(before);
  });

  it("draft cases stay out of the event stream until they move to Intake", async () => {
    const res = await newCase(A.cookie, customer, { draft: true });
    expect(res.json.status).toBe("Draft");
    const none = await connect("opsbridge_migrator");
    const q = "SELECT 1 FROM app.outbox WHERE workspace_id = $1 AND idempotency_key = $2";
    const key = `case:${res.json.id}:created`;
    expect((await none.query(q, [A.workspaceId, key])).rowCount).toBe(0);
    const moved = await call(`/api/v1/cases/${res.json.id}`, {
      method: "PATCH",
      cookie: A.cookie,
      body: { status: "Intake", version: 1 },
    });
    expect(moved.status).toBe(200);
    expect((await none.query(q, [A.workspaceId, key])).rowCount).toBe(1);
    await none.end();
  });
});

describe("P2.2 list, search and filter", () => {
  let A: Guest;
  const list = (cookie: string, query: string) => call(`/api/v1/cases?${query}`, { cookie });

  beforeAll(async () => {
    A = await launch();
  });

  it("own rows come first, then template, with a deterministic walk across both", async () => {
    const walk = async (limit: number) => {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 200; i++) {
        const q = `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const page = await list(A.cookie, q);
        expect(page.status).toBe(200);
        ids.push(...page.json.items.map((x: { id: string }) => x.id));
        cursor = page.json.nextCursor;
        if (!cursor) break;
      }
      return ids;
    };
    const small = await walk(7);
    expect(small).toHaveLength(123);
    expect(new Set(small).size).toBe(123);
    expect(await walk(50)).toEqual(small);
    const first = await list(A.cookie, "limit=4");
    expect(first.json.items.map((x: { readOnly: boolean }) => x.readOnly)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("rows added between pages don't repeat or shift the walk", async () => {
    const g = await launch();
    const first = await list(g.cookie, "limit=2");
    await newCase(g.cookie, await customerOf(g.cookie));
    const next = await list(
      g.cookie,
      `limit=2&cursor=${encodeURIComponent(first.json.nextCursor)}`,
    );
    const seen = [...first.json.items, ...next.json.items].map((x: { id: string }) => x.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("filters by status, queue, type, assignee and overdue", async () => {
    const byStatus = await list(A.cookie, "status=Ready&limit=100");
    expect(byStatus.json.items.every((x: { status: string }) => x.status === "Ready")).toBe(true);
    // 15 shared rows plus the pack's own Ready case.
    expect(byStatus.json.items).toHaveLength(16);
    const byQueue = await list(A.cookie, "queue=Seasonal%20Staffing&limit=100");
    expect(
      byQueue.json.items.every((x: { queue: string }) => x.queue === "Seasonal Staffing"),
    ).toBe(true);
    const byType = await list(A.cookie, "caseType=Field%20issue&limit=100");
    expect(byType.json.items.every((x: { caseType: string }) => x.caseType === "Field issue")).toBe(
      true,
    );
    const unassigned = await list(A.cookie, "assignee=unassigned&limit=100");
    expect(unassigned.json.items.every((x: { assigneeId: null }) => x.assigneeId === null)).toBe(
      true,
    );
    const person = (await call("/api/v1/assignees", { cookie: A.cookie })).json.items[0].id;
    const mine = await list(A.cookie, `assignee=${person}&limit=100`);
    expect(mine.json.items.length).toBeGreaterThan(0);
    const overdue = await list(A.cookie, "overdue=true&limit=100");
    for (const x of overdue.json.items) {
      expect(x.overdue).toBe(true);
      expect(["Approved", "Closed"]).not.toContain(x.status);
    }
  });

  it("search matches title and client, treats wildcards as text, and stays scoped", async () => {
    const hit = await list(A.cookie, "q=Harbor%20Ridge&limit=100");
    expect(hit.json.items.length).toBeGreaterThan(0);
    const wildcard = await list(A.cookie, "q=%25&limit=100");
    expect(wildcard.json.items).toEqual([]);
    const underscore = await list(A.cookie, "q=_&limit=100");
    expect(underscore.json.items).toEqual([]);
    const B = await launch();
    const target = (await packCases(B))["case-1"];
    await call(`/api/v1/cases/${target?.id}`, {
      method: "PATCH",
      cookie: B.cookie,
      body: { title: "Zephyr private", version: 1 },
    });
    expect((await list(A.cookie, "q=Zephyr")).json.items).toEqual([]);
    expect((await list(B.cookie, "q=Zephyr")).json.items).toHaveLength(1);
  });

  it("rejects bad filters and cursors", async () => {
    for (const q of [
      "status=Nope",
      "queue=Nope",
      "caseType=Nope",
      "assignee=nope",
      "overdue=yes",
      "limit=0",
      "limit=101",
      "cursor=1'--",
      `q=${"x".repeat(101)}`,
      `cursor=0_2026-01-01T00:00:00.000000Z_${"-".repeat(36)}`,
      "cursor=0_2026-13-45T00:00:00.000000Z_11111111-1111-4111-8111-111111111111",
      "cursor=0_2026-02-30T00:00:00.000000Z_11111111-1111-4111-8111-111111111111",
    ]) {
      expect((await list(A.cookie, q)).status, q).toBe(400);
    }
  });
});

describe("P2.2 detail, stale writes and ID swaps", () => {
  it("owner works in its own workspace with the same rules", async () => {
    const token = await mintOwnerToken();
    const headers = { "cf-access-jwt-assertion": token };
    const list = await call("/api/v1/cases?limit=5", { env: ownerEnv, headers });
    expect(list.json.items.every((x: { readOnly: boolean }) => x.readOnly === false)).toBe(true);
    const customers = await call("/api/v1/customers", { env: ownerEnv, headers });
    const made = await call("/api/v1/cases", {
      method: "POST",
      env: ownerEnv,
      headers: { ...headers, ...idempotencyKey() },
      body: { title: "Owner made", customerId: customers.json.items[0].id, caseType: "Billing" },
    });
    expect(made.status).toBe(201);
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT actor_type, actor_role FROM app.audit_events WHERE target = $1",
      [made.json.id],
    );
    await mig.end();
    expect(rows).toEqual([{ actor_type: "owner", actor_role: "owner" }]);
  });

  it("PATCH refuses unknown fields and empty changes", async () => {
    const g = await launch();
    const t = (await packCases(g))["case-1"];
    const patch = (body: unknown) =>
      call(`/api/v1/cases/${t?.id}`, { method: "PATCH", cookie: g.cookie, body });
    expect((await patch({ version: 1 })).status).toBe(400);
    expect((await patch({ version: 1, assigneeId: t?.id })).status).toBe(400);
    expect((await patch({ version: 1, queue: "Field Services" })).status).toBe(400);
    expect((await patch({ version: 1, title: "x", reason: "why" })).status).toBe(400);
    expect((await patch({ version: 1, dueAt: "2500-01-01T00:00:00Z" })).status).toBe(400);
    const dated = await patch({ version: 1, dueAt: "2030-06-01T00:00:00Z" });
    expect(dated.status).toBe(200);
    expect(dated.json.dueAt).toBe("2030-06-01T00:00:00.000Z");
    const cleared = await patch({ version: 2, dueAt: null });
    expect(cleared.json.dueAt).toBeNull();
  });

  it("two concurrent edits at one version: one wins, none is silently lost", async () => {
    const g = await launch();
    const t = (await packCases(g))["case-1"];
    const edit = (title: string) =>
      call(`/api/v1/cases/${t?.id}`, {
        method: "PATCH",
        cookie: g.cookie,
        body: { title, version: 1 },
      });
    const results = await Promise.all(["a", "b", "c", "d", "e"].map(edit));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    const winner = results.find((r) => r.status === 200);
    const now = await call(`/api/v1/cases/${t?.id}`, { cookie: g.cookie });
    expect(now.json.title).toBe(winner?.json.title);
    expect(now.json.version).toBe(2);
  });

  it("every write route refuses another workspace's IDs with the same 404", async () => {
    const A = await launch();
    const B = await launch();
    await setRole(A.cookie, "manager");
    const theirs = (await packCases(B))["case-2"];
    const detail = await call(`/api/v1/cases/${theirs?.id}`, { cookie: B.cookie });
    const item = detail.json.checklist[0];
    const attempts = [
      ["PATCH", `/api/v1/cases/${theirs?.id}`, { title: "x", version: 1 }],
      ["POST", `/api/v1/cases/${theirs?.id}/reopen`, { reason: "reason", version: 1 }],
      [
        "POST",
        `/api/v1/cases/${theirs?.id}/handoffs`,
        { toQueue: "Seasonal Staffing", reason: "x", expectedCaseVersion: 1 },
      ],
      ["PATCH", `/api/v1/cases/${theirs?.id}/checklist/${item.id}`, { state: "done", version: 1 }],
    ] as const;
    for (const [method, path, body] of attempts) {
      const res = await call(path, { method, cookie: A.cookie, body });
      expect(res.status, path).toBe(404);
    }
    const reads = [`/api/v1/cases/${theirs?.id}`, `/api/v1/cases/${theirs?.id}/activity`];
    for (const path of reads) {
      expect((await call(path, { cookie: A.cookie })).status).toBe(404);
    }
    const after = await call(`/api/v1/cases/${theirs?.id}`, { cookie: B.cookie });
    expect(after.json.version).toBe(1);
  });

  it("template detail reads as read-only and refuses every write", async () => {
    const A = await launch();
    await setRole(A.cookie, "manager");
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      `SELECT c.id FROM app.cases c JOIN app.workspaces w ON w.id = c.workspace_id
        WHERE w.mode = 'template' AND c.pack_key = 'case-2'`,
    );
    await mig.end();
    const id = rows[0].id;
    const detail = await call(`/api/v1/cases/${id}`, { cookie: A.cookie });
    expect(detail.json.readOnly).toBe(true);
    expect(detail.json.checklist).toHaveLength(3);
    const activity = await call(`/api/v1/cases/${id}/activity`, { cookie: A.cookie });
    expect(activity.json.items).toEqual([]);
    const item = detail.json.checklist[0];
    for (const [method, path, body] of [
      ["PATCH", `/api/v1/cases/${id}`, { title: "x", version: 1 }],
      ["PATCH", `/api/v1/cases/${id}/checklist/${item.id}`, { state: "done", version: 1 }],
      ["POST", `/api/v1/cases/${id}/reopen`, { reason: "reason", version: 1 }],
      [
        "POST",
        `/api/v1/cases/${id}/handoffs`,
        { toQueue: "Seasonal Staffing", reason: "x", expectedCaseVersion: 1 },
      ],
    ] as const) {
      expect((await call(path, { method, cookie: A.cookie, body })).status, path).toBe(403);
    }
  });

  it("activity pages newest first and never exposes actor IDs", async () => {
    const g = await launch();
    const t = (await packCases(g))["case-1"];
    for (let v = 1; v <= 3; v++) {
      await call(`/api/v1/cases/${t?.id}`, {
        method: "PATCH",
        cookie: g.cookie,
        body: { title: `Edit ${v}`, version: v },
      });
    }
    const first = await call(`/api/v1/cases/${t?.id}/activity?limit=2`, { cookie: g.cookie });
    expect(first.json.items).toHaveLength(2);
    expect(first.text).not.toMatch(/actor_id|actorId|before_hash/);
    expect(first.json.items[0].actor).toBe("analyst");
    const second = await call(
      `/api/v1/cases/${t?.id}/activity?limit=2&cursor=${first.json.nextCursor}`,
      { cookie: g.cookie },
    );
    expect(second.json.items).toHaveLength(1);
    expect(second.json.nextCursor).toBeUndefined();
    const bad = await call(`/api/v1/cases/${t?.id}/activity?cursor=abc`, { cookie: g.cookie });
    expect(bad.status).toBe(400);
  });
});
