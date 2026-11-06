import { Hono } from "hono";
import { requireActor, requireCapability } from "../auth/actor";
import { withWorkspace } from "../db";
import type { AppEnv } from "../env";

// The pick lists for the create and handoff forms. Own workspace only, because a template row
// can't be the target of a write. Guards sit on each route: this router is mounted at /api/v1,
// where a wildcard guard would turn every unknown path into a 401.
export const directory = new Hono<AppEnv>();

directory.get("/customers", requireActor, requireCapability("cases:read"), async (c) => {
  const { workspaceId } = c.get("actor");
  const { rows } = await withWorkspace(c.env.HYPERDRIVE, workspaceId, (db) =>
    db.query(
      `SELECT id, canonical_name, account_code FROM app.customers
        WHERE workspace_id = $1 ORDER BY canonical_name, id LIMIT 100`,
      [workspaceId],
    ),
  );
  return c.json({
    items: rows.map((r) => ({ id: r.id, name: r.canonical_name, accountCode: r.account_code })),
  });
});

directory.get("/assignees", requireActor, requireCapability("cases:read"), async (c) => {
  const { workspaceId } = c.get("actor");
  const { rows } = await withWorkspace(c.env.HYPERDRIVE, workspaceId, (db) =>
    db.query(
      `SELECT id, display_name, team, can_receive_cases FROM app.assignees
        WHERE workspace_id = $1 AND active ORDER BY display_name, id LIMIT 100`,
      [workspaceId],
    ),
  );
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.display_name,
      team: r.team,
      canReceiveCases: r.can_receive_cases,
    })),
  });
});
