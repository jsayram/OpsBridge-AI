import { describe, expect, it } from "vitest";
import { call, connect, cookieFrom, launch, tokenHash } from "./harness";

const LAUNCH = "/api/v1/demo/sessions";
const postJson = { method: "POST" };

describe("P1-A launch", () => {
  it("anonymous launch sets a hardened cookie and needs no credentials", async () => {
    const res = await call(LAUNCH, postJson);
    expect(res.status).toBe(201);
    const raw = res.headers.get("set-cookie") ?? "";
    expect(raw).toMatch(/^__Host-obs_demo=[A-Za-z0-9_-]{43};/);
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("Secure");
    expect(raw).toContain("SameSite=Strict");
    expect(raw).toContain("Path=/");
    expect(raw).toContain("Max-Age=7200");
    expect(raw).not.toContain("Domain");
    expect(res.json.packVersion).toBe("pack-1");
  });

  it("stores only a hash of the token", async () => {
    const res = await call(LAUNCH, postJson);
    const cookie = cookieFrom(res);
    const value = cookie.slice(cookie.indexOf("=") + 1);
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT token_hash FROM app.demo_sessions WHERE token_hash = $1",
      [await tokenHash(cookie)],
    );
    const raw = await mig.query(
      "SELECT count(*)::int AS n FROM app.demo_sessions WHERE encode(token_hash, 'escape') LIKE $1",
      [`%${value}%`],
    );
    await mig.end();
    expect(rows).toHaveLength(1);
    expect(raw.rows[0].n).toBe(0);
  });

  it("copies exactly the scenario pack, and two launches yield the same logical records", async () => {
    const shape = async (cookie: string) => {
      const list = await call("/api/v1/cases?limit=100", { cookie });
      const own = list.json.items.filter((x: { readOnly: boolean }) => !x.readOnly);
      return own
        .map((x: Record<string, unknown>) => [x.title, x.status, x.caseType, x.customer, x.version])
        .sort();
    };
    const a = await launch();
    const b = await launch();
    const [sa, sb] = [await shape(a.cookie), await shape(b.cookie)];
    expect(sa).toHaveLength(3);
    expect(sa).toEqual(sb);
    expect(a.caseId).not.toBe(b.caseId);
  });

  it("the seed shifts due dates and records the shift", async () => {
    const a = await launch();
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query("SELECT seed_clock_shift FROM app.workspaces WHERE id = $1", [
      a.workspaceId,
    ]);
    await mig.end();
    expect(rows[0].seed_clock_shift).not.toBeNull();
  });

  it("template clock in SQL matches the seed manifest", async () => {
    const { readFileSync } = await import("node:fs");
    const clock = JSON.parse(readFileSync("sample-data/seed-manifest.json", "utf8")).clock;
    const sql = readFileSync("backend/migrations/0001_foundation.sql", "utf8");
    expect(clock).toBe("2026-01-15T12:00:00Z");
    expect(sql).toContain("timestamptz '2026-01-15 12:00:00+00'");
  });

  it("launch is audited", async () => {
    const a = await launch();
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT action FROM app.audit_events WHERE workspace_id = $1",
      [a.workspaceId],
    );
    await mig.end();
    expect(rows).toEqual([{ action: "demo.launched" }]);
  });

  it("launch pause stops new workspaces", async () => {
    const res = await call(LAUNCH, { ...postJson, env: { DEMO_LAUNCH_PAUSED: "true" } });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("demo_paused");
  });

  it("missing IP key fails closed", async () => {
    const res = await call(LAUNCH, { ...postJson, env: { IP_HASH_KEY: undefined as never } });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("demo_unavailable");
  });
});

describe("P1-A reset", () => {
  it("swaps in a fresh workspace, rotates the token and kills the old cookie", async () => {
    const a = await launch();
    await call(`/api/v1/cases/${a.caseId}`, {
      method: "PATCH",
      cookie: a.cookie,
      body: { title: "Edited", version: 1 },
    });
    const res = await call("/api/v1/demo/reset", { ...postJson, cookie: a.cookie });
    expect(res.status).toBe(200);
    const fresh = cookieFrom(res);
    expect(fresh).not.toBe(a.cookie);
    const old = await call("/api/v1/me", { cookie: a.cookie });
    expect(old.status).toBe(401);
    expect(old.json.code).toBe("session_expired");
    const list = await call("/api/v1/cases?limit=100", { cookie: fresh });
    const own = list.json.items.filter((x: { readOnly: boolean }) => !x.readOnly);
    expect(own).toHaveLength(3);
    expect(own.some((x: { title: string }) => x.title === "Edited")).toBe(false);
    expect(own.some((x: { id: string }) => x.id === a.caseId)).toBe(false);
  });

  it("does not delete: the old workspace is expired for the sweep", async () => {
    const a = await launch();
    await call("/api/v1/demo/reset", { ...postJson, cookie: a.cookie });
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT expires_at <= now() AS expired FROM app.workspaces WHERE id = $1",
      [a.workspaceId],
    );
    await mig.end();
    expect(rows[0].expired).toBe(true);
  });

  it("E2E-18 repeated reset hits the session quota and affects nothing else", async () => {
    let cookie = (await launch()).cookie;
    const other = await launch();
    for (let i = 0; i < 2; i++) {
      const r = await call("/api/v1/demo/reset", {
        ...postJson,
        cookie,
        env: { DEMO_RESET_LIMIT: "2" },
      });
      expect(r.status).toBe(200);
      cookie = cookieFrom(r);
    }
    const over = await call("/api/v1/demo/reset", {
      ...postJson,
      cookie,
      env: { DEMO_RESET_LIMIT: "2" },
    });
    expect(over.status).toBe(429);
    expect(over.json.code).toBe("reset_quota");
    expect((await call("/api/v1/me", { cookie })).status).toBe(200);
    expect((await call("/api/v1/me", { cookie: other.cookie })).status).toBe(200);
  });

  it("concurrent resets on one session give one winner and no orphan session", async () => {
    const a = await launch();
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        call("/api/v1/demo/reset", { ...postJson, cookie: a.cookie }),
      ),
    );
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 401)).toHaveLength(4);
  });
});

describe("quotas", () => {
  it("per-IP hourly launch cap, partitioned by client address", async () => {
    const env = { DEMO_LAUNCH_HOURLY_LIMIT: "2" };
    const headers = { "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250)}` };
    const hit = () => call(LAUNCH, { ...postJson, env, headers });
    expect((await hit()).status).toBe(201);
    expect((await hit()).status).toBe(201);
    const over = await hit();
    expect(over.status).toBe(429);
    expect(over.json.code).toBe("launch_quota");
    const elsewhere = await call(LAUNCH, {
      ...postJson,
      env,
      headers: { "cf-connecting-ip": "203.0.113.200" },
    });
    expect(elsewhere.status).toBe(201);
  });

  it("X-Forwarded-For cannot dodge the cap", async () => {
    const env = { DEMO_LAUNCH_HOURLY_LIMIT: "1" };
    const ip = `192.0.2.${Math.floor(Math.random() * 250)}`;
    const hit = (xff: string) =>
      call(LAUNCH, {
        ...postJson,
        env,
        headers: { "cf-connecting-ip": ip, "x-forwarded-for": xff },
      });
    expect((await hit("1.1.1.1")).status).toBe(201);
    expect((await hit("2.2.2.2")).status).toBe(429);
  });

  it("the quota table holds no address", async () => {
    await call(LAUNCH, { ...postJson, headers: { "cf-connecting-ip": "203.0.113.77" } });
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT count(*)::int AS n FROM app.demo_quota WHERE encode(ip_bucket, 'escape') LIKE '%203.0.113.77%'",
    );
    await mig.end();
    expect(rows[0].n).toBe(0);
  });

  it("capacity refuses launch and reset, counting expired workspaces", async () => {
    const a = await launch();
    const env = { DEMO_WORKSPACE_CAP: "1" };
    const l = await call(LAUNCH, { ...postJson, env });
    expect(l.status).toBe(503);
    expect(l.json.code).toBe("demo_capacity");
    const r = await call("/api/v1/demo/reset", { ...postJson, cookie: a.cookie, env });
    expect(r.status).toBe(503);
    expect((await call("/api/v1/me", { cookie: a.cookie })).status).toBe(200);
  });
});

describe("session lifecycle", () => {
  it("rejects a forged or malformed cookie without leaking why", async () => {
    const forged = await call("/api/v1/me", { cookie: `__Host-obs_demo=${"A".repeat(43)}` });
    const junk = await call("/api/v1/me", { cookie: "__Host-obs_demo=../../etc" });
    expect([forged.status, junk.status]).toEqual([401, 401]);
    expect(forged.json.code).toBe(junk.json.code);
  });

  it("no session means 401 on every protected route", async () => {
    for (const path of ["/api/v1/me", "/api/v1/cases", "/api/v1/workspace/summary"]) {
      expect((await call(path)).status).toBe(401);
    }
    for (const path of ["/api/v1/demo/reset", "/api/v1/demo/role"]) {
      expect((await call(path, { method: "POST", body: {} })).status).toBe(401);
    }
  });

  it("session fixation: a preset cookie is never adopted", async () => {
    const preset = `__Host-obs_demo=${"B".repeat(43)}`;
    const res = await call(LAUNCH, { ...postJson, cookie: preset });
    expect(cookieFrom(res)).not.toBe(preset);
    expect((await call("/api/v1/me", { cookie: preset })).status).toBe(401);
  });

  it("E2E-21 an expired session stops working mid-use and clears the cookie", async () => {
    const a = await launch();
    const mig = await connect("opsbridge_migrator");
    await mig.query(
      "UPDATE app.demo_sessions SET expires_at = now() - interval '1 second' WHERE workspace_id = $1",
      [a.workspaceId],
    );
    await mig.end();
    const res = await call(`/api/v1/cases/${a.caseId}`, {
      method: "PATCH",
      cookie: a.cookie,
      body: { title: "Late edit", version: 1 },
    });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe("session_expired");
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("a session on an expired workspace is dead even if its own expiry is later", async () => {
    const a = await launch();
    const mig = await connect("opsbridge_migrator");
    await mig.query(
      "UPDATE app.workspaces SET expires_at = now() - interval '1 second' WHERE id = $1",
      [a.workspaceId],
    );
    await mig.end();
    expect((await call("/api/v1/me", { cookie: a.cookie })).status).toBe(401);
  });
});

describe("demo role", () => {
  it("switches among the three simulated roles, server-side", async () => {
    const a = await launch();
    for (const role of ["viewer", "manager", "analyst"]) {
      const res = await call("/api/v1/demo/role", { cookie: a.cookie, body: { role } });
      expect(res.status).toBe(200);
      const me = await call("/api/v1/me", { cookie: a.cookie });
      expect(me.json.demoRole).toBe(role);
    }
  });

  it("E2E-04 owner and admin values are rejected, and so are extra fields", async () => {
    const a = await launch();
    for (const role of ["owner", "admin", "Manager", "", null, 1]) {
      const res = await call("/api/v1/demo/role", { cookie: a.cookie, body: { role } });
      expect(res.status).toBe(400);
    }
    const extra = await call("/api/v1/demo/role", {
      cookie: a.cookie,
      body: { role: "viewer", isAdmin: true },
    });
    expect(extra.status).toBe(400);
    const me = await call("/api/v1/me", { cookie: a.cookie });
    expect(me.json.demoRole).toBe("analyst");
    expect(me.json.capabilities).not.toContain("admin:access");
  });

  it("viewer loses edit, analyst keeps it", async () => {
    const a = await launch();
    await call("/api/v1/demo/role", { cookie: a.cookie, body: { role: "viewer" } });
    const edit = () =>
      call(`/api/v1/cases/${a.caseId}`, {
        method: "PATCH",
        cookie: a.cookie,
        body: { title: "Viewer edit", version: 1 },
      });
    expect((await edit()).status).toBe(403);
    await call("/api/v1/demo/role", { cookie: a.cookie, body: { role: "analyst" } });
    expect((await edit()).status).toBe(200);
  });
});

describe("CSRF", () => {
  it("rejects a cross-origin or originless state change", async () => {
    const a = await launch();
    const evil = await call("/api/v1/demo/reset", {
      ...postJson,
      cookie: a.cookie,
      origin: "https://evil.example.com",
    });
    expect(evil.status).toBe(403);
    expect(evil.json.code).toBe("origin_rejected");
    const none = await call("/api/v1/demo/reset", { ...postJson, cookie: a.cookie, origin: null });
    expect(none.status).toBe(403);
    expect((await call(LAUNCH, { ...postJson, origin: "null" })).status).toBe(403);
    expect((await call("/api/v1/me", { cookie: a.cookie })).status).toBe(200);
  });

  it("rejects a form-encoded body, the classic cross-site form", async () => {
    const a = await launch();
    const res = await call("/api/v1/demo/role", {
      method: "POST",
      cookie: a.cookie,
      rawBody: "role=viewer",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(415);
  });

  it("outside local, a state change needs a configured APP_ORIGIN", async () => {
    const env = { ENVIRONMENT: "staging" };
    expect((await call(LAUNCH, { ...postJson, env })).status).toBe(403);
    const ok = await call(LAUNCH, {
      ...postJson,
      env: { ...env, APP_ORIGIN: "https://stage.example.com" },
      origin: "https://stage.example.com",
    });
    expect(ok.status).toBe(201);
  });
});
