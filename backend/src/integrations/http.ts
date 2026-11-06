import { AdapterError, FAILURE_POLICY, type FailureClass, type Transport } from "./types";

// PRD 8.1 and docs/design/INTEGRATION-CONTRACTS.md: 8 s timeout, 3 retries with jittered
// backoff, 429 honors Retry-After, 401, 403 and validation errors don't retry.
export type RetryPolicy = {
  timeoutMs: number;
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  // A longer wait isn't slept through inside a request. The run fails and an operator resumes.
  maxRetryAfterSeconds: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
};

export const DEFAULT_POLICY: RetryPolicy = {
  timeoutMs: 8_000,
  retries: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  maxRetryAfterSeconds: 10,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

export const backoffMs = (attempt: number, policy: RetryPolicy) => {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(ceiling / 2 + policy.random() * (ceiling / 2));
};

export function classifyStatus(status: number): FailureClass | null {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 429) return "rate_limited";
  if (status === 408 || status >= 500) return "transient";
  if (status >= 400) return "invalid_payload";
  return null;
}

const retryAfter = (res: Response) => {
  const value = res.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - Date.now()) / 1000);
};

async function once(transport: Transport, build: () => Request, timeoutMs: number) {
  const signal = AbortSignal.timeout(timeoutMs);
  const pending = transport(new Request(build(), { signal }));
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new AdapterError("transient", "timeout")));
  });
  try {
    return await Promise.race([pending, timedOut]);
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    const name = e instanceof Error ? e.name : "";
    throw new AdapterError("transient", name === "TimeoutError" ? "timeout" : "network_error");
  }
}

// The only way an adapter talks to a source. Returns a 2xx response; everything else is an
// AdapterError carrying a class and a code, with no provider text.
export async function callWithPolicy(
  transport: Transport,
  build: () => Request,
  policy: RetryPolicy = DEFAULT_POLICY,
): Promise<Response> {
  let last: AdapterError | null = null;
  for (let attempt = 0; attempt <= policy.retries; attempt++) {
    if (attempt > 0) {
      const asked = last?.retryAfterSeconds;
      await policy.sleep(asked !== undefined ? asked * 1000 : backoffMs(attempt - 1, policy));
    }
    try {
      const res = await once(transport, build, policy.timeoutMs);
      if (res.ok) return res;
      const failure = classifyStatus(res.status) ?? "invalid_payload";
      const wait = failure === "rate_limited" ? retryAfter(res) : undefined;
      await res.body?.cancel().catch(() => {});
      throw new AdapterError(failure, `http_${res.status}`, wait);
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e;
      last = e;
      if (!FAILURE_POLICY[e.failure].retry) throw e;
      if ((e.retryAfterSeconds ?? 0) > policy.maxRetryAfterSeconds) throw e;
    }
  }
  throw last ?? new AdapterError("transient", "retries_exhausted");
}

export async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new AdapterError("invalid_payload", "malformed_json");
  }
}
