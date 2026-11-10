import { describe, expect, it } from "vitest";
import { app } from "../../backend/src/app";

describe("platform routes", () => {
  it("returns a minimal liveness payload", async () => {
    const res = await app.request("/health/live", undefined, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("sends security headers", async () => {
    const res = await app.request("/health/live", undefined, {});
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("returns the standard error envelope with no internals", async () => {
    const res = await app.request("/api/v1/nope", undefined, {});
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(["code", "message", "requestId"]);
    expect(body.code).toBe("not_found");
  });
});
