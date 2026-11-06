import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

export type Bindings = { ASSETS: Fetcher };

export const app = new Hono<{ Bindings: Bindings }>();

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    referrerPolicy: "no-referrer",
  }),
);

// Health stays dependency-free so a monitor can never wake the database.
app.get("/health/live", (c) => c.json({ status: "ok" }));
app.get("/health/ready", (c) => c.json({ status: "ok" }));

const errorBody = (code: string, message: string) => ({
  code,
  message,
  requestId: crypto.randomUUID(),
});

app.notFound((c) => c.json(errorBody("not_found", "Not found"), 404));
app.onError((err, c) => {
  console.error(JSON.stringify({ level: "error", message: err.message }));
  return c.json(errorBody("internal_error", "Something went wrong"), 500);
});
