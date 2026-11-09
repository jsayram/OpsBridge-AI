import { pgCode, withClient } from "../db";
import type { Bindings } from "../env";
import { log } from "../http/log";

// Cron path, opsbridge_cleanup role only. One transaction per workspace; the next sweep
// retries anything that fails. The function caps a run at 5 workspaces.
export async function sweepDemoWorkspaces(env: Bindings): Promise<number> {
  return withClient(env.HYPERDRIVE_CLEANUP, async (db) => {
    const { rows } = await db.query("SELECT app.expired_demo_workspaces(5) AS id");
    let purged = 0;
    for (const { id } of rows) {
      try {
        await db.query("SELECT app.purge_demo_workspace($1)", [id]);
        purged++;
      } catch (e) {
        log({ level: "error", event: "purge_failed", dbCode: pgCode(e) ?? "unknown" });
      }
    }
    await db.query("SELECT app.purge_stale_demo_quota()");
    await db.query("SELECT app.purge_expired_idempotency_keys()");
    // Deferred findings return to the queue on their date (PRD 7.2).
    await db.query("SELECT app.release_deferred_findings(50)");
    // AI reviews stuck in Processing for over 5 minutes become Failed and can be retried (P5).
    await db.query("SELECT app.fail_stuck_ai_reviews(50)");
    log({ level: "info", event: "sweep", purged });
    return purged;
  });
}
