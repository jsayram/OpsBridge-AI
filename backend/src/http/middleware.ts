import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { ipBucketKey } from "../auth/tokens";
import type { AppEnv } from "../env";
import { ApiError } from "./errors";
import { log } from "./log";

const CF_IP = "cf-connecting-ip";

// Cloudflare sets this header and strips client copies. X-Forwarded-For is never trusted.
export const clientIp = (c: Context<AppEnv>) => c.req.header(CF_IP) ?? "local";

export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  c.set("requestId", requestId);
  await next();
  c.header("X-Request-Id", requestId);
  log({
    level: c.res.status >= 500 ? "error" : "info",
    event: "request",
    requestId,
    method: c.req.method,
    route: routePath(c),
    status: c.res.status,
    durationMs: Date.now() - started,
    actor: c.get("actor")?.kind ?? "anonymous",
    ...(c.get("errorCode") ? { code: c.get("errorCode") } : {}),
  });
};

export const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
};

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

// Every state change must prove it came from our own origin and speak JSON. Together with
// SameSite=Strict this is the CSRF defense from the threat model.
export const originCheck: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE.has(c.req.method)) return next();
  const local = c.env.ENVIRONMENT === "local";
  const allowed = c.env.APP_ORIGIN ?? (local ? new URL(c.req.url).origin : undefined);
  if (!allowed || c.req.header("origin") !== allowed) {
    throw new ApiError(403, "origin_rejected", "This request came from another site");
  }
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  const hasBody = (c.req.header("content-length") ?? "0") !== "0" || c.req.raw.body !== null;
  if (hasBody && type !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Send JSON");
  }
  return next();
};

// Approximate outer layer. The hard limits are the database quotas.
export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const limiter = c.env.API_RATE_LIMITER;
  if (limiter) {
    const key = await ipBucketKey(c.env, clientIp(c));
    const { success } = await limiter.limit({ key });
    if (!success) throw new ApiError(429, "rate_limited", "Too many requests. Wait a moment.");
  }
  return next();
};
