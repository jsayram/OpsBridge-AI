import { describe, expect, it } from "vitest";
import { call, connect, cookieFrom, launch } from "./harness";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// P1 carry-forward. An advisory lock parks reset between its session lock and its workspace
// update, which is the window a purge can land in when a workspace expires mid-reset.
describe("reset meeting purge at the expiry boundary", () => {
  it("both finish without a deadlock, and nothing is left half-done", async () => {
    const guest = await launch();
    const gate = await connect("opsbridge_migrator");
    const mig = await connect("opsbridge_migrator");
    const clean = await connect("opsbridge_cleanup");
    await gate.query("BEGIN");
    await gate.query("SELECT pg_advisory_xact_lock(727001)");
    const reset = call("/api/v1/demo/reset", { method: "POST", cookie: guest.cookie });
    await pause(300);
    await mig.query(
      "UPDATE app.workspaces SET expires_at = now() - interval '5 minutes' WHERE id = $1",
      [guest.workspaceId],
    );
    const purge = clean
      .query("SELECT app.purge_demo_workspace($1)", [guest.workspaceId])
      .then(() => "purged")
      .catch((e) => String(e.code));
    await pause(300);
    await gate.query("COMMIT");
    const res = await reset;
    const outcome = await purge;
    console.log(`reset=${res.status} ${res.json.code ?? ""} purge=${outcome}`);
    await Promise.all([gate.end(), mig.end(), clean.end()]);
    expect(res.status).toBe(200);
    expect(outcome).toBe("purged");
    const after = await call("/api/v1/cases?limit=1", { cookie: cookieFrom(res) });
    expect(after.status).toBe(200);
  });
});
