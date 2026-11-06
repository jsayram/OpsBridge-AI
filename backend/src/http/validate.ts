import type { Context } from "hono";
import { invalidRequest } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID.test(value);

// Strict DTOs: any field not named here is rejected, which is the mass-assignment defense.
export async function readStrictJson(
  c: Context,
  allowed: readonly string[],
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw invalidRequest("Body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalidRequest("Body must be a JSON object");
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidRequest("Unknown field in request");
  }
  return body as Record<string, unknown>;
}
