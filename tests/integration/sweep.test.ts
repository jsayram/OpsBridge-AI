import { describe, expect, it } from "vitest";
import { sweepDemoWorkspaces } from "../../backend/src/jobs/sweep";
import { baseEnv, connect, launch } from "./harness";

describe("cron sweep", () => {
  it("purges expired demo workspaces only, at most 5 a run, and clears old quota rows", async () => {
    const mig = await connect("opsbridge_migrator");
    const guests = await Promise.all(Array.from({ length: 7 }, () => launch()));
    const live = await launch();
    await mig.query(
      "UPDATE app.workspaces SET expires_at = now() - interval '1 minute' WHERE id = ANY($1)",
      [guests.map((g) => g.workspaceId)],
    );
    await mig.query(
      "INSERT INTO app.demo_quota (ip_bucket, hour, launches) VALUES (decode(repeat('ab', 32), 'hex'), now() - interval '3 hours', 1) ON CONFLICT DO NOTHING",
    );
    const sizes = await mig.query(
      "SELECT mode, count(*)::int AS n FROM app.cases c JOIN app.workspaces w ON w.id = c.workspace_id WHERE w.mode <> 'demo' GROUP BY 1 ORDER BY 1",
    );
    const expiredBefore = (
      await mig.query(
        "SELECT count(*)::int AS n FROM app.workspaces WHERE mode = 'demo' AND expires_at < now()",
      )
    ).rows[0].n;
    const first = await sweepDemoWorkspaces(baseEnv());
    expect(first).toBe(5);
    const expiredAfter = (
      await mig.query(
        "SELECT count(*)::int AS n FROM app.workspaces WHERE mode = 'demo' AND expires_at < now()",
      )
    ).rows[0].n;
    expect(expiredBefore - expiredAfter).toBe(5);
    const stale = await mig.query(
      "SELECT count(*)::int AS n FROM app.demo_quota WHERE hour < now() - interval '2 hours'",
    );
    expect(stale.rows[0].n).toBe(0);
    const same = await mig.query(
      "SELECT mode, count(*)::int AS n FROM app.cases c JOIN app.workspaces w ON w.id = c.workspace_id WHERE w.mode <> 'demo' GROUP BY 1 ORDER BY 1",
    );
    expect(same.rows).toEqual(sizes.rows);
    const liveRow = await mig.query("SELECT 1 FROM app.workspaces WHERE id = $1", [
      live.workspaceId,
    ]);
    expect(liveRow.rowCount).toBe(1);
    await mig.end();
  });

  it("the sweep drains a backlog across runs", async () => {
    let total = 0;
    for (let i = 0; i < 40; i++) {
      const n = await sweepDemoWorkspaces(baseEnv());
      total += n;
      if (n === 0) break;
    }
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT count(*)::int AS n FROM app.workspaces WHERE mode = 'demo' AND expires_at < now() - interval '60 seconds'",
    );
    await mig.end();
    expect(rows[0].n).toBe(0);
    expect(total).toBeGreaterThan(0);
  });
});
