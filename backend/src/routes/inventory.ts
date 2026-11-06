import { Hono } from "hono";
import { requireActor, requireCapability } from "../auth/actor";
import { withWorkspace } from "../db";
import type { AppEnv } from "../env";
import { invalidRequest } from "../http/errors";
import { listInventory } from "../repo/inventory";

// GET only. There is no inventory write route of any kind, and that is the requirement.
export const inventory = new Hono<AppEnv>();

inventory.get("/", requireActor, requireCapability("inventory:read"), async (c) => {
  const actor = c.get("actor");
  const limit = Number(c.req.query("limit") ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidRequest("Bad limit");
  const after = c.req.query("cursor");
  if (after && !/^[\w.-]{1,40}$/.test(after)) throw invalidRequest("Bad cursor");
  const page = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    listInventory(db, {
      workspaceId: actor.workspaceId,
      shared: c.req.query("scope") === "shared" && actor.kind === "guest",
      limit,
      ...(after ? { after } : {}),
    }),
  );
  return c.json(page);
});
