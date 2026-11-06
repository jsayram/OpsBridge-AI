import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { ownerGate } from "./auth/actor";
import { pgCode } from "./db";
import type { AppEnv } from "./env";
import { ApiError, errorBody, notFound } from "./http/errors";
import { log } from "./http/log";
import { noStore, originCheck, rateLimit, requestContext } from "./http/middleware";
import { admin } from "./routes/admin";
import { cases } from "./routes/cases";
import { demo } from "./routes/demo";
import { me } from "./routes/me";

export type { Bindings } from "./env";

// Must match frontend/public/_headers, which covers the static assets. A unit test holds
// the two together.
export const PAGE_CSP = {
  defaultSrc: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'self'"],
};
const PERMISSIONS = { camera: [], microphone: [], geolocation: [] };
const apiHeaders = secureHeaders({
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  referrerPolicy: "no-referrer",
  permissionsPolicy: PERMISSIONS,
  // PRD 6.3: HSTS only after the domain is verified. Enabled at P1.5 with the real origin.
  strictTransportSecurity: false,
});
const pageHeaders = secureHeaders({
  contentSecurityPolicy: PAGE_CSP,
  referrerPolicy: "no-referrer",
  permissionsPolicy: PERMISSIONS,
  // PRD 6.3: HSTS only after the domain is verified. Enabled at P1.5 with the real origin.
  strictTransportSecurity: false,
});

const MAX_BODY_BYTES = 16 * 1024;

export const app = new Hono<AppEnv>();

app.use("*", requestContext);
app.use("*", (c, next) =>
  c.req.path.startsWith("/admin") ? pageHeaders(c, next) : apiHeaders(c, next),
);

// Health stays dependency-free so a monitor can never wake the database.
app.get("/health/live", (c) => c.json({ status: "ok" }));
app.get("/health/ready", (c) => c.json({ status: "ok" }));

app.use("/api/*", noStore, rateLimit, originCheck);
app.use(
  "/api/*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new ApiError(413, "payload_too_large", "Request body is too large");
    },
  }),
);

app.use("/api/v1/admin/*", ownerGate);
app.route("/api/v1/admin", admin);
app.route("/api/v1/demo", demo);
app.route("/api/v1/cases", cases);
app.route("/api/v1", me);

// The SPA page for /admin is only served to a verified owner.
app.use("/admin", ownerGate);
app.use("/admin/*", ownerGate);
const adminPage = async (c: Context<AppEnv>) => {
  // Asset responses have immutable headers, so copy before the header middleware runs.
  const page = new Response((await c.env.ASSETS.fetch(new URL("/", c.req.url))).body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
  return page;
};
app.get("/admin", adminPage);
app.get("/admin/*", adminPage);

app.notFound((c) => {
  const e = notFound();
  return c.json(errorBody(e.code, e.message, c.get("requestId")), e.status);
});

app.onError((err, c) => {
  const requestId = c.get("requestId");
  if (err instanceof ApiError) {
    c.set("errorCode", err.code);
    return c.json(errorBody(err.code, err.message, requestId), err.status);
  }
  if (err instanceof HTTPException) {
    c.set("errorCode", "http_exception");
    return c.json(errorBody("invalid_request", "Invalid request", requestId), err.status);
  }
  c.set("errorCode", "internal_error");
  log({
    level: "error",
    event: "unhandled_error",
    requestId,
    errorName: err.name,
    ...(pgCode(err) ? { dbCode: pgCode(err) as string } : {}),
  });
  return c.json(errorBody("internal_error", "Something went wrong", requestId), 500);
});
