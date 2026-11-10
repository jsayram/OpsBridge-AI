import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  callLiveModel,
  GatewayError,
  gatewayState,
  HARD_CAPS,
  PROVIDERS,
} from "../../backend/src/ai/gateway";
import type { Bindings } from "../../backend/src/env";

// A labeled test double for the provider. It records requests and never touches the network.
const KEY = "test-double-key-not-a-real-credential-0001";
const library = JSON.parse(readFileSync("sample-data/documents/manifest.json", "utf8"));
const doc = library.documents[0];
const okBody = (text: string, usage = { input_tokens: 900, output_tokens: 300 }) =>
  JSON.stringify({ content: [{ type: "text", text }], usage, stop_reason: "end_turn" });

function double(respond: (req: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const transport = async (req: Request) => {
    seen.push(req.clone() as Request);
    return respond(req);
  };
  return { seen, transport: transport as unknown as NonNullable<Bindings["AI_TEST_DOUBLE"]> };
}

const env = (extra: Record<string, unknown> = {}): Bindings =>
  ({
    ENVIRONMENT: "local",
    AI_LIVE_ENABLED: "true",
    AI_PROVIDER: "anthropic",
    AI_MODEL: "test-double-model",
    AI_API_KEY: KEY,
    AI_MAX_REQUESTS_PER_DAY: "5",
    AI_MAX_INPUT_TOKENS: "4000",
    AI_MAX_OUTPUT_TOKENS: "1000",
    AI_MAX_CONCURRENCY: "1",
    AI_TIMEOUT_MS: "2000",
    AI_PRICE_IN_MICRO_USD_PER_MTOK: "1000000",
    AI_PRICE_OUT_MICRO_USD_PER_MTOK: "5000000",
    ...extra,
  }) as Bindings;

describe("live gateway configuration (P5.3)", () => {
  const d = double(() => new Response(okBody(doc.fixtureOutput)));
  it("is off unless every setting is present", () => {
    expect(gatewayState({} as Bindings)).toEqual({ ready: false, code: "live_ai_disabled" });
    expect(gatewayState(env({ AI_API_KEY: undefined }))).toMatchObject({
      code: "live_ai_key_missing",
    });
    expect(gatewayState(env({ AI_MAX_CONCURRENCY: undefined }))).toMatchObject({
      code: "live_ai_limits_missing",
    });
    expect(gatewayState(env({ AI_PRICE_IN_MICRO_USD_PER_MTOK: undefined }))).toMatchObject({
      code: "live_ai_price_missing",
    });
    expect(gatewayState(env({ AI_PROVIDER: "https://evil.example.com" }))).toMatchObject({
      code: "live_ai_provider_not_allowed",
    });
  });
  it("refuses limits above the hard caps", () => {
    expect(
      gatewayState(
        env({
          AI_MAX_OUTPUT_TOKENS: String(HARD_CAPS.outputTokens + 1),
          AI_TEST_DOUBLE: d.transport,
        }),
      ),
    ).toMatchObject({ code: "live_ai_limits_missing" });
    expect(
      gatewayState(env({ AI_MAX_REQUESTS_PER_DAY: "0", AI_TEST_DOUBLE: d.transport })),
    ).toMatchObject({ code: "live_ai_limits_missing" });
  });
  it("needs the in-process double locally and never falls back to the network", () => {
    expect(gatewayState(env())).toEqual({ ready: false, code: "live_ai_local_requires_double" });
    expect(gatewayState(env({ AI_TEST_DOUBLE: d.transport })).ready).toBe(true);
  });
  it("stays off when the environment is unset or unknown, so nothing falls through to the network", () => {
    expect(gatewayState(env({ ENVIRONMENT: undefined }))).toMatchObject({
      code: "live_ai_environment_unknown",
    });
    expect(gatewayState(env({ ENVIRONMENT: "prod" }))).toMatchObject({
      code: "live_ai_environment_unknown",
    });
  });
  it("ignores the double outside local", () => {
    const s = gatewayState(env({ ENVIRONMENT: "staging", AI_TEST_DOUBLE: d.transport }));
    if (!s.ready) throw new Error("expected ready");
    expect(s.config.transport).not.toBe(d.transport);
  });
});

describe("live gateway call against the labeled double", () => {
  const configWith = (
    transport: (r: Request) => Promise<Response>,
    extra: Partial<Bindings> = {},
  ) => {
    const s = gatewayState(env({ AI_TEST_DOUBLE: transport, ...extra }));
    if (!s.ready) throw new Error(s.code);
    return s.config;
  };

  it("sends one request to the fixed destination with the key only in its header", async () => {
    const d = double(() => new Response(okBody(doc.fixtureOutput)));
    const out = await callLiveModel(configWith(d.transport), doc.segments);
    expect(d.seen).toHaveLength(1);
    const req = d.seen[0] as Request;
    expect(req.url).toBe(PROVIDERS.anthropic.url);
    expect(req.headers.get("x-api-key")).toBe(KEY);
    const body = await req.text();
    expect(body).not.toContain(KEY);
    const json = JSON.parse(body);
    expect(json.max_tokens).toBe(1000);
    expect(json).not.toHaveProperty("tools");
    expect(out).toMatchObject({ raw: doc.fixtureOutput, tokensIn: 900, tokensOut: 300 });
    // 900 tokens at $1 and 300 at $5 per million: $0.0024, which is 2,400 micro-USD.
    expect(out.costMicroUsd).toBe(2400);
  });

  const failures: [string, () => Response | Promise<Response>, string][] = [
    ["5xx", () => new Response("down", { status: 503 }), "provider_unavailable"],
    [
      "429",
      () => new Response("slow", { status: 429, headers: { "retry-after": "30" } }),
      "provider_rate_limited",
    ],
    ["401", () => new Response("no", { status: 401 }), "provider_auth"],
    [
      "redirect",
      () => new Response(null, { status: 302, headers: { location: "https://evil.example.com" } }),
      "provider_unavailable",
    ],
    ["malformed body", () => new Response("not json"), "provider_malformed"],
    [
      "tool-use block",
      () =>
        new Response(
          JSON.stringify({
            content: [{ type: "tool_use", name: "send_email", input: {} }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ),
      "provider_non_text_output",
    ],
    [
      "two blocks",
      () =>
        new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ),
      "provider_malformed",
    ],
    [
      "output over the cap",
      () => new Response(okBody("{}", { input_tokens: 10, output_tokens: 5000 })),
      "output_limit_reached",
    ],
    ["timeout", () => new Promise<Response>(() => {}), "provider_timeout"],
  ];
  for (const [name, respond, code] of failures) {
    it(`maps ${name} to ${code} with one call and no retry`, async () => {
      const d = double(respond);
      const err = await callLiveModel(
        configWith(d.transport, { AI_TIMEOUT_MS: "50" }),
        doc.segments,
      ).catch((e) => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect(err.code).toBe(code);
      expect(String(err.message)).not.toContain(KEY);
      expect(d.seen.length).toBe(1);
    });
  }

  it("refuses input over the token cap before any call", async () => {
    const d = double(() => new Response(okBody(doc.fixtureOutput)));
    const big = Array.from({ length: 200 }, (_, i) => ({
      id: `p1-s${i + 1}`,
      page: 1,
      text: "x".repeat(100),
    }));
    const err = await callLiveModel(configWith(d.transport), big).catch((e) => e);
    expect(err.code).toBe("input_too_large");
    expect(d.seen).toHaveLength(0);
  });
});
