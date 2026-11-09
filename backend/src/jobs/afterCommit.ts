import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { dispatchDue } from "./dispatch";

// Commands that can emit an outbox event. Everything else skips the extra query.
const EMITTING =
  /^\/api\/v1\/(cases|approvals|reconciliation|integrations|admin\/integrations|admin\/automations\/runs)\b/;

// After a successful write, hand this workspace's due events to the dispatcher. waitUntil runs it
// after the response, so the command's transaction has committed and the visitor doesn't wait.
export const dispatchAfterCommit: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (c.req.method === "GET" || c.res.status >= 300 || !EMITTING.test(c.req.path)) return;
  const actor = c.get("actor");
  if (!actor) return;
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    const ctx = c.executionCtx;
    waitUntil = (p) => ctx.waitUntil(p);
  } catch {
    return;
  }
  waitUntil(dispatchDue(c.env, { workspaceId: actor.workspaceId }));
};
