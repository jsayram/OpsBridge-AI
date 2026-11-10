import { Hono } from "hono";
import { capabilitiesOf, requireActor } from "../auth/actor";
import { withWorkspace } from "../db";
import type { AppEnv } from "../env";

export const me = new Hono<AppEnv>();

// Capabilities come from the server. Nothing in this response is editable by the client.
me.get("/me", requireActor, async (c) => {
  const actor = c.get("actor");
  const capabilities = capabilitiesOf(actor);
  if (actor.kind === "owner") {
    return c.json({ kind: "owner", capabilities, workspaceMode: "owner" });
  }
  const { rows } = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    db.query("SELECT name FROM app.workspaces WHERE id = $1", [actor.workspaceId]),
  );
  const expiresInSeconds = Math.max(0, Math.floor((actor.expiresAt.getTime() - Date.now()) / 1000));
  return c.json({
    kind: "guest",
    demoRole: actor.demoRole,
    capabilities,
    workspaceMode: "demo",
    workspaceName: rows[0]?.name ?? "Demo workspace",
    expiresAt: actor.expiresAt.toISOString(),
    expiresInSeconds,
    environment: c.env.ENVIRONMENT ?? "production",
  });
});

me.get("/workspace/summary", requireActor, async (c) => {
  const actor = c.get("actor");
  const { rows } = await withWorkspace(c.env.HYPERDRIVE, actor.workspaceId, (db) =>
    db.query(
      `SELECT c.status, c.workspace_id = $1 AS own, count(*)::int AS n
         FROM app.cases c
        WHERE c.workspace_id = $1
           OR ($2 AND c.workspace_id = (SELECT id FROM app.workspaces WHERE mode = 'template'))
        GROUP BY 1, 2`,
      [actor.workspaceId, actor.kind === "guest"],
    ),
  );
  const tally = (own: boolean) =>
    Object.fromEntries(rows.filter((r) => r.own === own).map((r) => [r.status, r.n]));
  return c.json({
    provenance: "SYNTHETIC",
    workspaceCases: tally(true),
    templateCases: tally(false),
  });
});
