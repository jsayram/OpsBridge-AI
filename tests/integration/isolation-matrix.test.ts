import { beforeAll, describe, expect, it } from "vitest";
import { call, connect, cookieFrom, launch, type Guest, mintOwnerToken, ownerEnv } from "./harness";

// P1-B and PRD P1.3: two guests plus the owner, swapping every ID and token.
describe("cross-workspace matrix", () => {
  let A: Guest;
  let B: Guest;
  let ownerCase: string;
  let templateCase: string;
  let ownerToken: string;
  const ownerCall = (path: string, options = {}) =>
    call(path, {
      ...options,
      env: ownerEnv,
      headers: { "cf-access-jwt-assertion": ownerToken },
    });

  beforeAll(async () => {
    A = await launch();
    B = await launch();
    ownerToken = await mintOwnerToken();
    const mig = await connect("opsbridge_migrator");
    ownerCase = (
      await mig.query(
        "SELECT c.id FROM app.cases c JOIN app.workspaces w ON w.id = c.workspace_id WHERE w.mode = 'owner'",
      )
    ).rows[0].id;
    templateCase = (
      await mig.query(
        "SELECT c.id FROM app.cases c JOIN app.workspaces w ON w.id = c.workspace_id WHERE w.mode = 'template' ORDER BY c.id LIMIT 1",
      )
    ).rows[0].id;
    await mig.end();
  });

  it("each guest reads its own case", async () => {
    expect((await call(`/api/v1/cases/${A.caseId}`, { cookie: A.cookie })).json.id).toBe(A.caseId);
    expect((await call(`/api/v1/cases/${B.caseId}`, { cookie: B.cookie })).json.id).toBe(B.caseId);
  });

  it("guest reading another guest's or the owner's ID gets the same 404 as a random ID", async () => {
    const random = "11111111-1111-4111-8111-111111111111";
    const bodies = [];
    for (const id of [B.caseId, ownerCase, random]) {
      const res = await call(`/api/v1/cases/${id}`, { cookie: A.cookie });
      expect(res.status).toBe(404);
      const { requestId: _drop, ...rest } = res.json;
      bodies.push(rest);
    }
    expect(bodies[0]).toEqual(bodies[2]);
    expect(bodies[1]).toEqual(bodies[2]);
  });

  it("guest writing another guest's or the owner's ID changes nothing", async () => {
    for (const id of [B.caseId, ownerCase]) {
      const res = await call(`/api/v1/cases/${id}`, {
        method: "PATCH",
        cookie: A.cookie,
        body: { title: "Attack", version: 1 },
      });
      expect(res.status).toBe(404);
    }
    const b = await call(`/api/v1/cases/${B.caseId}`, { cookie: B.cookie });
    expect(b.json.title).not.toBe("Attack");
    const o = await ownerCall(`/api/v1/cases/${ownerCase}`);
    expect(o.json.title).not.toBe("Attack");
  });

  it("template rows read as read-only and refuse writes", async () => {
    const read = await call(`/api/v1/cases/${templateCase}`, { cookie: A.cookie });
    expect(read.status).toBe(200);
    expect(read.json.readOnly).toBe(true);
    const write = await call(`/api/v1/cases/${templateCase}`, {
      method: "PATCH",
      cookie: A.cookie,
      body: { title: "Attack", version: 1 },
    });
    expect(write.status).toBe(403);
  });

  it("owner reads its own case but not guest or template rows", async () => {
    expect((await ownerCall(`/api/v1/cases/${ownerCase}`)).status).toBe(200);
    expect((await ownerCall(`/api/v1/cases/${A.caseId}`)).status).toBe(404);
    expect((await ownerCall(`/api/v1/cases/${templateCase}`)).status).toBe(404);
  });

  it("lists never mix workspaces", async () => {
    const list = await call("/api/v1/cases?limit=100", { cookie: A.cookie });
    const ids = list.json.items.map((x: { id: string }) => x.id);
    expect(ids).toContain(A.caseId);
    expect(ids).not.toContain(B.caseId);
    expect(ids).not.toContain(ownerCase);
    const own = await ownerCall("/api/v1/cases?limit=100");
    expect(own.json.items.map((x: { id: string }) => x.id)).toEqual([ownerCase]);
  });

  it("pagination walks a bounded list without repeats", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const q = `limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await call(`/api/v1/cases?${q}`, { cookie: A.cookie });
      for (const x of page.json.items) {
        expect(seen.has(x.id)).toBe(false);
        seen.add(x.id);
      }
      cursor = page.json.nextCursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(123);
    expect((await call("/api/v1/cases?limit=101", { cookie: A.cookie })).status).toBe(400);
    expect((await call("/api/v1/cases?cursor=1'--", { cookie: A.cookie })).status).toBe(400);
  });

  it("A's reset touches only A", async () => {
    const res = await call("/api/v1/demo/reset", { method: "POST", cookie: A.cookie });
    expect(res.status).toBe(200);
    A = { ...A, cookie: cookieFrom(res) };
    expect((await call(`/api/v1/cases/${B.caseId}`, { cookie: B.cookie })).status).toBe(200);
    expect((await ownerCall(`/api/v1/cases/${ownerCase}`)).status).toBe(200);
  });

  it("owner cannot reset or switch role", async () => {
    expect((await ownerCall("/api/v1/demo/reset", { method: "POST" })).status).toBe(403);
    expect((await ownerCall("/api/v1/demo/role", { body: { role: "viewer" } })).status).toBe(403);
  });

  it("swapped cookies follow the session, not the ID in the URL", async () => {
    const asB = await call(`/api/v1/cases/${B.caseId}`, { cookie: B.cookie });
    const asAWithBId = await call(`/api/v1/cases/${B.caseId}`, { cookie: A.cookie });
    expect(asB.status).toBe(200);
    expect(asAWithBId.status).toBe(404);
  });

  it("request bodies can't choose a workspace", async () => {
    const res = await call(`/api/v1/cases/${B.caseId}`, {
      method: "PATCH",
      cookie: B.cookie,
      body: { title: "x", version: 1, workspace_id: "00000000-0000-4000-8000-000000000002" },
    });
    expect(res.status).toBe(400);
  });

  it("stale version gets a typed conflict and the write is audited once", async () => {
    const list = await call("/api/v1/cases?limit=1", { cookie: B.cookie });
    const target = list.json.items[0];
    const first = await call(`/api/v1/cases/${target.id}`, {
      method: "PATCH",
      cookie: B.cookie,
      body: { title: "Renamed", version: target.version },
    });
    expect(first.status).toBe(200);
    const stale = await call(`/api/v1/cases/${target.id}`, {
      method: "PATCH",
      cookie: B.cookie,
      body: { title: "Too late", version: target.version },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("stale_version");
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT before_hash, after_hash, request_id FROM app.audit_events WHERE workspace_id = $1 AND action = 'case.updated' AND target = $2",
      [B.workspaceId, target.id],
    );
    await mig.end();
    expect(rows).toHaveLength(1);
    expect(rows[0].before_hash).not.toBe(rows[0].after_hash);
    expect(rows[0].request_id).toBe(first.headers.get("x-request-id"));
  });

  it("SQL injection strings stay data", async () => {
    const target = (await call("/api/v1/cases?limit=1", { cookie: A.cookie })).json.items[0];
    const title = "x'; DROP TABLE app.cases; --";
    const res = await call(`/api/v1/cases/${target.id}`, {
      method: "PATCH",
      cookie: A.cookie,
      body: { title, version: target.version },
    });
    expect(res.status).toBe(200);
    expect(res.json.title).toBe(title);
    expect((await call("/api/v1/cases/'%20OR%201=1--", { cookie: A.cookie })).status).toBe(404);
    expect((await call("/api/v1/cases?status='%20OR%201=1", { cookie: A.cookie })).status).toBe(
      400,
    );
  });
});
