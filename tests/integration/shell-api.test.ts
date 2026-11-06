import { afterEach, describe, expect, it, vi } from "vitest";
import { call, cookieFrom, launch } from "./harness";

const logged = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.flat().join("\n");

describe("request IDs and error envelope", () => {
  it("every response carries a request ID, and errors repeat it in the body", async () => {
    const res = await call("/api/v1/nope");
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.json.requestId).toBe(id);
    expect(Object.keys(res.json).sort()).toEqual(["code", "message", "requestId"]);
    expect((await call("/health/live")).headers.get("x-request-id")).toBeTruthy();
  });

  it("a client-sent request ID is ignored", async () => {
    const res = await call("/api/v1/nope", { headers: { "x-request-id": "attacker-chosen" } });
    expect(res.headers.get("x-request-id")).not.toBe("attacker-chosen");
  });

  it("database down gives a typed 503, not a stack trace", async () => {
    const res = await call("/api/v1/demo/sessions", {
      method: "POST",
      env: { HYPERDRIVE: { connectionString: "postgres://x:y@127.0.0.1:1/none" } as never },
    });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("database_unavailable");
    expect(res.text).not.toContain("127.0.0.1");
  });

  it("health never reports environment or dependency detail", async () => {
    for (const path of ["/health/live", "/health/ready"]) {
      const res = await call(path, {
        env: { HYPERDRIVE: { connectionString: "postgres://x:y@127.0.0.1:1/none" } as never },
      });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ status: "ok" });
    }
  });
});

describe("request limits", () => {
  it("oversized body gets 413", async () => {
    const g = await launch();
    const res = await call(`/api/v1/cases/${g.caseId}`, {
      method: "PATCH",
      cookie: g.cookie,
      rawBody: JSON.stringify({ title: "x".repeat(20_000), version: 1 }),
    });
    expect(res.status).toBe(413);
  });

  it("malformed JSON and non-object bodies get 400", async () => {
    const g = await launch();
    for (const rawBody of ["{nope", "[]", "null", '"x"']) {
      const res = await call("/api/v1/demo/role", { method: "POST", cookie: g.cookie, rawBody });
      expect(res.status).toBe(400);
    }
  });

  it("rate-limit binding, when present, answers 429 with the envelope", async () => {
    const res = await call("/api/v1/nope", {
      env: { API_RATE_LIMITER: { limit: async () => ({ success: false }) } },
    });
    expect(res.status).toBe(429);
    expect(res.json.code).toBe("rate_limited");
  });
});

describe("security headers", () => {
  it("API responses are locked down and uncacheable", async () => {
    const g = await launch();
    const res = await call("/api/v1/me", { cookie: g.cookie });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBeTruthy();
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("errors carry the same headers", async () => {
    const res = await call("/api/v1/me");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("P1-D log redaction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("no cookie, token, body, query or address reaches a log line", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("/api/v1/demo/sessions", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });
    const cookie = cookieFrom(res);
    const value = cookie.slice(cookie.indexOf("=") + 1);
    const canary = "CANARY-sk-live-do-not-log";
    await call(`/api/v1/cases?cursor=${canary}`, { cookie });
    await call("/api/v1/demo/role", { cookie, body: { role: canary } });
    await call("/api/v1/admin/status", {
      headers: { "cf-access-jwt-assertion": canary, authorization: `Bearer ${canary}` },
    });
    await call("/api/v1/demo/sessions", {
      method: "POST",
      env: {
        HYPERDRIVE: { connectionString: "postgres://canaryuser:canarypass@127.0.0.1:1/x" } as never,
      },
    });
    const out = `${logged(info)}\n${logged(error)}`;
    expect(out.length).toBeGreaterThan(100);
    for (const secret of [value, canary, "203.0.113.9", "canarypass", "canaryuser"]) {
      expect(out).not.toContain(secret);
    }
    for (const line of out.split("\n")) {
      const parsed = JSON.parse(line);
      expect(parsed.ts).toBeTruthy();
      expect(parsed.event).toBeTruthy();
    }
  });

  it("a failure produces a correlated, redacted log line", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await call("/api/v1/demo/sessions", {
      method: "POST",
      env: { HYPERDRIVE: { connectionString: "postgres://x:y@127.0.0.1:1/none" } as never },
    });
    expect(res.status).toBe(503);
    const line = logged(error);
    expect(line).toContain(res.json.requestId);
  });
});
