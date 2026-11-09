import { readFileSync } from "node:fs";
import type { Bindings } from "../../backend/src/env";
import { call, idempotencyKey, mintOwnerToken, ownerEnv } from "./harness";

// A labeled double for the AI provider (P5.3, DEC-008). It lives in this process, records what it
// was sent, and answers from a script. Nothing here can reach a network: the gateway only uses a
// double when ENVIRONMENT is "local", and tests/setup/no-network.ts blocks outside sockets.
export const DOUBLE_KEY = "test-double-key-not-a-real-credential-0001";

export const library = JSON.parse(readFileSync("sample-data/documents/manifest.json", "utf8"));
export const fixture = (id: string) =>
  library.documents.find((d: { fixtureId: string }) => d.fixtureId === id);

export type ModelDouble = {
  env: Partial<Bindings>;
  requests: { url: string; headers: Record<string, string>; body: string }[];
  respond: (req: Request) => Response | Promise<Response>;
};

export const textReply = (text: string, usage = { input_tokens: 800, output_tokens: 250 }) =>
  new Response(
    JSON.stringify({ content: [{ type: "text", text }], usage, stop_reason: "end_turn" }),
  );

export function modelDouble(
  respond: ModelDouble["respond"],
  limits: Partial<Record<string, string>> = {},
): ModelDouble {
  const d: ModelDouble = {
    requests: [],
    respond,
    env: {},
  };
  d.env = {
    AI_LIVE_ENABLED: "true",
    AI_PROVIDER: "anthropic",
    AI_MODEL: "test-double-model",
    AI_API_KEY: DOUBLE_KEY,
    AI_MAX_REQUESTS_PER_DAY: "50",
    AI_MAX_INPUT_TOKENS: "4000",
    AI_MAX_OUTPUT_TOKENS: "1000",
    AI_MAX_CONCURRENCY: "1",
    AI_TIMEOUT_MS: "200",
    AI_PRICE_IN_MICRO_USD_PER_MTOK: "1000000",
    AI_PRICE_OUT_MICRO_USD_PER_MTOK: "5000000",
    ...limits,
    // biome-ignore lint/correctness/noComponentHookFactories: an env binding, not a component
    AI_TEST_DOUBLE: async (req: Request) => {
      d.requests.push({
        url: req.url,
        headers: Object.fromEntries(req.headers),
        body: await req.clone().text(),
      });
      return d.respond(req);
    },
  };
  return d;
}

export const asOwner = async (
  path: string,
  options: {
    method?: string;
    body?: unknown;
    env?: Partial<Bindings>;
    key?: boolean;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {},
) =>
  call(path, {
    ...(options.method ? { method: options.method } : {}),
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(options.rawBody !== undefined ? { rawBody: options.rawBody } : {}),
    env: { ...ownerEnv, ...(options.env ?? {}) },
    headers: {
      "cf-access-jwt-assertion": await mintOwnerToken(),
      ...(options.key ? idempotencyKey() : {}),
      ...(options.headers ?? {}),
    },
  });
