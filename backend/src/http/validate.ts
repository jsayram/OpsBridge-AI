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

const MAX_VERSION = 2_147_483_647;
const EARLIEST = Date.parse("2000-01-01T00:00:00Z");
const LATEST = Date.parse("2100-01-01T00:00:00Z");

export const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_VERSION;

export function requireVersion(value: unknown): number {
  if (!isVersion(value)) throw invalidRequest("Version is required");
  return value;
}

export function requireText(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\u0000")
  ) {
    throw invalidRequest(`${label} must be 1 to ${max} characters`);
  }
  return value.trim();
}

export const optionalText = (value: unknown, label: string, max: number) =>
  value === undefined || value === null ? undefined : requireText(value, label, max);

export function requireDate(value: unknown, label: string): string {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at) || at < EARLIEST || at > LATEST) throw invalidRequest(`Bad ${label}`);
  return new Date(at).toISOString();
}

export function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw invalidRequest(`Bad ${label}`);
  }
  return value as T;
}

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,64}$/;

export function requireIdempotencyKey(c: Context): string {
  const key = c.req.header("idempotency-key");
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw invalidRequest("An Idempotency-Key header of 8 to 64 characters is required");
  }
  return key;
}
