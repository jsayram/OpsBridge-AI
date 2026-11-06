import { describe, expect, it } from "vitest";
import {
  backoffMs,
  callWithPolicy,
  classifyStatus,
  DEFAULT_POLICY,
  type RetryPolicy,
} from "../../backend/src/integrations/http";
import { AdapterError } from "../../backend/src/integrations/types";

const policy = (over: Partial<RetryPolicy> = {}) => {
  const slept: number[] = [];
  return {
    slept,
    policy: {
      ...DEFAULT_POLICY,
      random: () => 0.5,
      sleep: async (ms: number) => void slept.push(ms),
      ...over,
    } as RetryPolicy,
  };
};
const req = () => new Request("https://source.invalid/x");
const series = (...statuses: (number | [number, string])[]) => {
  let i = 0;
  const calls = { n: 0 };
  const transport = async () => {
    calls.n++;
    const s = statuses[Math.min(i++, statuses.length - 1)] as number | [number, string];
    return Array.isArray(s)
      ? new Response("{}", { status: s[0], headers: { "retry-after": s[1] } })
      : new Response("{}", { status: s });
  };
  return { transport, calls };
};

describe("retry policy", () => {
  it("classifies every status the contract names", () => {
    expect(classifyStatus(401)).toBe("auth");
    expect(classifyStatus(403)).toBe("permission");
    expect(classifyStatus(429)).toBe("rate_limited");
    expect(classifyStatus(500)).toBe("transient");
    expect(classifyStatus(503)).toBe("transient");
    expect(classifyStatus(408)).toBe("transient");
    expect(classifyStatus(400)).toBe("invalid_payload");
    expect(classifyStatus(200)).toBeNull();
  });

  it("backoff grows, stays jittered and is capped", () => {
    const { policy: p } = policy({ random: () => 1 });
    expect(backoffMs(0, p)).toBe(250);
    expect(backoffMs(1, p)).toBe(500);
    expect(backoffMs(10, p)).toBe(4000);
    expect(backoffMs(0, { ...p, random: () => 0 })).toBe(125);
  });

  it("retries a 500 up to three times, then gives up", async () => {
    const { transport, calls } = series(500);
    const { policy: p, slept } = policy();
    await expect(callWithPolicy(transport, req, p)).rejects.toMatchObject({
      failure: "transient",
      code: "http_500",
    });
    expect(calls.n).toBe(4);
    expect(slept).toHaveLength(3);
    expect(slept[1]).toBeGreaterThan(slept[0] as number);
  });

  it("recovers when a retry succeeds", async () => {
    const { transport, calls } = series(503, 200);
    const res = await callWithPolicy(transport, req, policy().policy);
    expect(res.status).toBe(200);
    expect(calls.n).toBe(2);
  });

  it("401 and 403 and 400 never retry", async () => {
    for (const status of [401, 403, 400, 404]) {
      const { transport, calls } = series(status);
      await expect(callWithPolicy(transport, req, policy().policy)).rejects.toBeInstanceOf(
        AdapterError,
      );
      expect(calls.n).toBe(1);
    }
  });

  it("429 honors Retry-After in seconds", async () => {
    const { transport } = series([429, "2"], 200);
    const { policy: p, slept } = policy();
    await callWithPolicy(transport, req, p);
    expect(slept).toEqual([2000]);
  });

  it("429 honors Retry-After as a date", async () => {
    const { transport } = series([429, new Date(Date.now() + 3000).toUTCString()], 200);
    const { policy: p, slept } = policy();
    await callWithPolicy(transport, req, p);
    expect(slept[0]).toBeGreaterThan(0);
    expect(slept[0]).toBeLessThanOrEqual(3000);
  });

  it("429 without Retry-After, as NetSuite documents it, uses backoff", async () => {
    const { transport } = series(429, 200);
    const { policy: p, slept } = policy();
    await callWithPolicy(transport, req, p);
    expect(slept).toEqual([187]);
  });

  it("a Retry-After past the limit stops at once rather than sleeping", async () => {
    const { transport, calls } = series([429, "600"]);
    const { policy: p, slept } = policy();
    await expect(callWithPolicy(transport, req, p)).rejects.toMatchObject({
      failure: "rate_limited",
    });
    expect(calls.n).toBe(1);
    expect(slept).toEqual([]);
  });

  it("really times out a source that never answers", async () => {
    const never = () => new Promise<Response>(() => {});
    const { policy: p } = policy({ timeoutMs: 20, retries: 1 });
    await expect(callWithPolicy(never, req, p)).rejects.toMatchObject({
      failure: "transient",
      code: "timeout",
    });
  });

  it("a network failure is transient and carries no provider text", async () => {
    const transport = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1 token=abc");
    };
    const { policy: p } = policy({ retries: 0 });
    const e = await callWithPolicy(transport, req, p).catch((x) => x);
    expect(e.code).toBe("network_error");
    expect(e.message).toBe("network_error");
  });

  it("an error body never reaches the error", async () => {
    const transport = async () => new Response(JSON.stringify({ secret: "leak" }), { status: 400 });
    const e = await callWithPolicy(transport, req, policy().policy).catch((x) => x);
    expect(JSON.stringify({ m: e.message, c: e.code })).not.toContain("leak");
  });
});
