import { type Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import { type GuestActor, requireActor, requireCapability } from "../auth/actor";
import { isDemoRole } from "../auth/policy";
import { DEMO_COOKIE, hashToken, ipBucket, newDemoToken } from "../auth/tokens";
import { pgCode, withClient } from "../db";
import type { AppEnv, Bindings } from "../env";
import { ApiError, invalidRequest } from "../http/errors";
import { log } from "../http/log";
import { clientIp } from "../http/middleware";
import { readStrictJson } from "../http/validate";

const PACK_VERSION = "pack-1";

const setSessionCookie = (c: Context<AppEnv>, token: string, maxAge: number) =>
  setCookie(c, DEMO_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge,
  });

const lifecycleError = (e: unknown): never => {
  switch (pgCode(e)) {
    case "P0003":
      throw new ApiError(503, "demo_capacity", "The demo is full right now. Try again later.");
    case "P0004":
      throw new ApiError(429, "launch_quota", "Too many demo launches. Try again within the hour.");
    case "P0005":
      throw new ApiError(429, "reset_quota", "This session has used all of its resets.");
    case "P0006":
      throw new ApiError(503, "demo_unavailable", "The demo is not available right now.");
    case "55P03": // lock_timeout
    case "57014": // statement_timeout
    case "40P01": // deadlock, reset meeting a purge at the expiry boundary
      throw new ApiError(503, "demo_busy", "The demo is busy. Try again in a moment.");
    default:
      throw e;
  }
};

const sessionBody = (row: { session_expires_at: Date; role: string }) => ({
  expiresAt: row.session_expires_at.toISOString(),
  packVersion: PACK_VERSION,
  demoRole: row.role,
});

const demoAvailable = (env: Bindings): string => {
  if (env.DEMO_LAUNCH_PAUSED === "true") {
    throw new ApiError(503, "demo_paused", "New demo sessions are paused.");
  }
  if (!env.IP_HASH_KEY) {
    log({ level: "error", event: "config_missing", code: "ip_hash_key" });
    throw new ApiError(503, "demo_unavailable", "The demo is not available right now.");
  }
  return env.IP_HASH_KEY;
};

const maxAge = (expiresAt: Date) =>
  Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));

export const demo = new Hono<AppEnv>();

demo.post("/sessions", async (c) => {
  const key = demoAvailable(c.env);
  const token = newDemoToken();
  const tokenHash = await hashToken(token);
  const bucket = await ipBucket(key, clientIp(c));
  const { rows } = await withClient(c.env.HYPERDRIVE, (db) =>
    db
      .query("SELECT * FROM app.launch_demo_session($1, $2)", [tokenHash, bucket])
      .catch(lifecycleError),
  );
  setSessionCookie(c, token, maxAge(rows[0].session_expires_at));
  return c.json(sessionBody(rows[0]), 201);
});

demo.post("/reset", requireActor, requireCapability("demo:reset"), async (c) => {
  const key = demoAvailable(c.env);
  const actor = c.get("actor") as GuestActor;
  const token = newDemoToken();
  const newHash = await hashToken(token);
  const bucket = await ipBucket(key, clientIp(c));
  const { rows } = await withClient(c.env.HYPERDRIVE, (db) =>
    db
      .query("SELECT * FROM app.reset_demo_session($1, $2, $3)", [actor.tokenHash, newHash, bucket])
      .catch(lifecycleError),
  );
  const row = rows[0];
  if (!row) throw new ApiError(401, "session_expired", "Your demo session has ended");
  setSessionCookie(c, token, maxAge(row.session_expires_at));
  return c.json(sessionBody(row));
});

demo.post("/role", requireActor, requireCapability("demo:switch_role"), async (c) => {
  const actor = c.get("actor") as GuestActor;
  const { role } = await readStrictJson(c, ["role"]);
  if (!isDemoRole(role)) throw invalidRequest("Role must be viewer, analyst or manager");
  const { rows } = await withClient(c.env.HYPERDRIVE, (db) =>
    db.query("SELECT app.set_demo_role($1, $2) AS role", [actor.tokenHash, role]),
  );
  if (!rows[0]?.role) throw new ApiError(401, "session_expired", "Your demo session has ended");
  return c.json({ demoRole: rows[0].role });
});
