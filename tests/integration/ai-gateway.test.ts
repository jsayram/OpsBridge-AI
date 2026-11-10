import { beforeEach, describe, expect, it } from "vitest";
import { asOwner, DOUBLE_KEY, fixture, modelDouble, textReply } from "./ai-double";
import { OWNER_WORKSPACE_ID } from "./automation-helpers";
import { connect } from "./harness";

// P5.3 against the labeled double only. Pending Owner Credentials: no provider account exists.
const OWNER_CASE = "00000000-0000-4000-8000-000000000004";
const ownerDoc = async (fixtureId = "fx-standard-02") => {
  const res = await asOwner(`/api/v1/cases/${OWNER_CASE}/documents/from-fixture`, {
    body: { fixtureId },
    key: true,
  });
  if (res.status !== 201) throw new Error(`${res.status} ${res.text}`);
  return res.json.id as string;
};
const live = (doc: string, env: Record<string, unknown>) =>
  asOwner(`/api/v1/documents/${doc}/review`, { body: { mode: "live" }, env: env as never });

async function usage() {
  const mig = await connect("opsbridge_migrator");
  const { rows } = await mig.query(
    "SELECT requests, tokens_in, tokens_out, cost_micro_usd FROM app.ai_usage WHERE workspace_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date",
    [OWNER_WORKSPACE_ID],
  );
  await mig.end();
  return rows[0] ?? { requests: 0, tokens_in: 0, tokens_out: 0, cost_micro_usd: "0" };
}

describe("owner-only live gateway (P5.3, E2E-14)", () => {
  beforeEach(async () => {
    // Usage is per day, so each test starts from a clean owner budget.
    const mig = await connect("opsbridge_migrator");
    await mig.query("DELETE FROM app.ai_usage WHERE workspace_id = $1", [OWNER_WORKSPACE_ID]);
    await mig.query(
      "UPDATE app.ai_reviews SET status = 'Failed', error_code = 'test_reset' WHERE workspace_id = $1 AND status = 'Processing'",
      [OWNER_WORKSPACE_ID],
    );
    await mig.end();
  });

  it("without configuration, a live request gets the labeled fixture and says why", async () => {
    const res = await live(await ownerDoc(), {});
    expect(res.status).toBe(201);
    expect(res.json.degraded).toBe("live_ai_disabled");
    expect(res.json.review).toMatchObject({
      mode: "fixture",
      label: "Deterministic demonstration fixture",
    });
    expect(res.json.review.validation.fallback).toEqual({ from: "live", code: "live_ai_disabled" });
  });

  it("with the double configured, stores a labeled live result with tokens and estimated cost", async () => {
    const d = modelDouble(() => textReply(fixture("fx-standard-02").fixtureOutput));
    const res = await live(await ownerDoc(), d.env);
    expect(res.status).toBe(201);
    expect(res.json.review).toMatchObject({
      status: "Needs Human Review",
      mode: "live",
      label: "Live model output",
      modelVersion: "anthropic:test-double-model",
      tokensIn: 800,
      tokensOut: 250,
      costMicroUsd: 2050,
    });
    expect(d.requests).toHaveLength(1);
    expect(d.requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    const sent = JSON.parse(d.requests[0]?.body as string);
    expect(sent.system).toMatch(/untrusted data/);
    expect(sent).not.toHaveProperty("tools");
    expect(await usage()).toMatchObject({ requests: 1, tokens_in: 800, tokens_out: 250 });
  });

  it("stops at the daily request limit before calling, and falls back", async () => {
    const d = modelDouble(() => textReply(fixture("fx-standard-02").fixtureOutput), {
      AI_MAX_REQUESTS_PER_DAY: "2",
    });
    for (let i = 0; i < 2; i++)
      expect((await live(await ownerDoc(), d.env)).json.review.mode).toBe("live");
    const third = await live(await ownerDoc(), d.env);
    expect(third.json.degraded).toBe("live_ai_daily_limit");
    expect(third.json.review.mode).toBe("fixture");
    expect(d.requests).toHaveLength(2);
  });

  it("stops at the concurrency limit before calling", async () => {
    const mig = await connect("opsbridge_migrator");
    const doc = await ownerDoc();
    await mig.query(
      `INSERT INTO app.ai_reviews (workspace_id, document_id, model_version, prompt_version, mode,
                                   status, processing_started_at, attempts)
       VALUES ($1, $2, 'anthropic:test-double-model', 'doc-review-v1', 'live', 'Processing', now(), 1)`,
      [OWNER_WORKSPACE_ID, doc],
    );
    await mig.end();
    const d = modelDouble(() => textReply(fixture("fx-standard-02").fixtureOutput));
    const res = await live(await ownerDoc(), d.env);
    expect(res.json.degraded).toBe("live_ai_concurrency_limit");
    expect(d.requests).toHaveLength(0);
  });

  const outages: [string, () => Response | Promise<Response>, string][] = [
    [
      "provider down",
      () => new Response("upstream error with secret-ish text", { status: 503 }),
      "provider_unavailable",
    ],
    ["rate limited", () => new Response("", { status: 429 }), "provider_rate_limited"],
    ["timeout", () => new Promise<Response>(() => {}), "provider_timeout"],
    ["malformed", () => new Response("<html>oops</html>"), "provider_malformed"],
  ];
  for (const [name, respond, code] of outages) {
    it(`${name}: the live row fails with a code, one call only, and the fixture answers`, async () => {
      const d = modelDouble(respond);
      const res = await live(await ownerDoc(), d.env);
      expect(res.status).toBe(201);
      expect(res.json.review).toMatchObject({ status: "Failed", mode: "live", errorCode: code });
      expect(res.json.degraded).toBe(code);
      expect(res.json.fallback).toMatchObject({ status: "Needs Human Review", mode: "fixture" });
      expect(d.requests).toHaveLength(1);
      expect(res.text).not.toContain("secret-ish");
    });
  }

  const hostile: [string, (o: Record<string, unknown>) => unknown][] = [
    [
      "a tool call",
      (o) => ({ ...o, tool_calls: [{ name: "send_email", to: "exfil@example.com" }] }),
    ],
    [
      "a URL in a value",
      (o) => ({
        ...o,
        extractedFields: {
          ...(o.extractedFields as object),
          clientName: "see https://evil.example.com",
        },
      }),
    ],
    [
      "an invented citation",
      (o) => ({
        ...o,
        perFieldSource: { ...(o.perFieldSource as object), clientName: ["p7-s99"] },
      }),
    ],
    [
      "a status change",
      (o) => ({ ...o, proposedAction: { kind: "set_status", status: "Approved" } }),
    ],
  ];
  for (const [name, mutate] of hostile) {
    it(`model output with ${name} is rejected, never stored as a suggestion`, async () => {
      const good = JSON.parse(fixture("fx-adversarial-31").fixtureOutput);
      const d = modelDouble(() => textReply(JSON.stringify(mutate(good))));
      const res = await live(await ownerDoc("fx-adversarial-31"), d.env);
      expect(res.json.review).toMatchObject({
        status: "Failed",
        errorCode: "output_rejected",
        suggestion: null,
      });
      expect(res.json.review.validation.valid).toBe(false);
      expect(res.json.fallback.mode).toBe("fixture");
    });
  }

  it("counts the usage of a paid call whose answer was refused, and a failed live row can't be silently retried", async () => {
    const d = modelDouble(() => textReply("{}", { input_tokens: 700, output_tokens: 5000 }));
    const res = await live(await ownerDoc(), d.env);
    expect(res.json.review).toMatchObject({
      status: "Failed",
      errorCode: "output_limit_reached",
      tokensOut: 5000,
    });
    expect(await usage()).toMatchObject({ requests: 1, tokens_in: 700, tokens_out: 5000 });
    const retry = await asOwner(`/api/v1/ai-reviews/${res.json.review.id}/retry`, {
      method: "POST",
    });
    expect([retry.status, retry.json.code]).toEqual([409, "live_retry_is_new_request"]);
  });

  it("never writes the key to a response, an audit row, a review row or a log line", async () => {
    const logs: string[] = [];
    const spy =
      (orig: (...a: unknown[]) => void) =>
      (...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
        orig(...a);
      };
    const [log, err] = [console.log, console.error];
    console.log = spy(log);
    console.error = spy(err);
    try {
      const d = modelDouble(() => new Response("bad", { status: 500 }));
      const res = await live(await ownerDoc(), d.env);
      expect(res.text).not.toContain(DOUBLE_KEY);
      expect(d.requests[0]?.headers["x-api-key"]).toBe(DOUBLE_KEY);
    } finally {
      console.log = log;
      console.error = err;
    }
    expect(logs.join("\n")).not.toContain(DOUBLE_KEY);
    const mig = await connect("opsbridge_migrator");
    const leaks = await mig.query(
      `SELECT (SELECT count(*) FROM app.audit_events WHERE summary LIKE $1 OR action LIKE $1)
            + (SELECT count(*) FROM app.ai_reviews WHERE row_to_json(ai_reviews)::text LIKE $1) AS n`,
      [`%${DOUBLE_KEY}%`],
    );
    await mig.end();
    expect(Number(leaks.rows[0].n)).toBe(0);
  });
});
