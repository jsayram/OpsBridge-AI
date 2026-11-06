import { type Context, Hono } from "hono";
import { requireActor, requireCapability } from "../auth/actor";
import { hashHex } from "../auth/tokens";
import { type Client, inWorkspaceTx, withClient, withWorkspace } from "../db";
import type { AppEnv } from "../env";
import { ApiError, forbidden } from "../http/errors";
import { canonicalId, readStrictJson, requireIdempotencyKey } from "../http/validate";
import { simulatedAdapter } from "../integrations/adapters";
import {
  isScenario,
  SCENARIO_NAMES,
  SCENARIOS,
  type Scenario,
  scenarioApplies,
} from "../integrations/scenarios";
import type { Provider, SourceAdapter } from "../integrations/types";
import { commandContext, idempotent } from "../repo/records";
import {
  claimRun,
  loadConnection,
  PROVIDER_LABEL,
  requireScenario,
  runDto,
  startRun,
  stepRun,
} from "../repo/sync";

const FRESH_MS = 86_400_000;
const AGING_MS = 7 * FRESH_MS;

export const freshness = (at: Date | null, now = Date.now()) => {
  if (!at) return "never";
  const age = now - at.getTime();
  return age <= FRESH_MS ? "fresh" : age <= AGING_MS ? "aging" : "stale";
};

type Row = Record<string, unknown>;

// An allowlist. secret_reference, cursors and anything else on the row stay on the server.
const connectionDto = (c: Row) => {
  const provider = c.provider as Provider;
  return {
    id: c.id,
    provider,
    label: PROVIDER_LABEL[provider],
    mode: c.mode,
    modeLabel: c.mode === "simulated" ? "Simulated" : "Connected Test",
    status: c.status,
    lastSuccessAt: (c.last_success_at as Date | null)?.toISOString() ?? null,
    freshness: freshness(c.last_success_at as Date | null),
    lastErrorCode: c.last_error_code,
    scenarios:
      c.mode === "simulated"
        ? SCENARIO_NAMES.filter((s) => scenarioApplies(s, provider)).map((name) => ({
            name,
            label: SCENARIOS[name].label,
          }))
        : [],
  };
};

export const adapterForSimulated = (
  connection: Row,
  scenario: Scenario,
  resumes: number,
): SourceAdapter => {
  // Which adapter runs comes from the connection row, never from the request.
  if (connection.mode !== "simulated") throw forbidden();
  return simulatedAdapter(connection.provider as Exclude<Provider, "salesforce_test">, {
    scenario,
    faultsActive: resumes === 0,
    shiftMs: Number(connection.shift_ms),
  });
};

type AdapterFor = {
  live: boolean;
  build: (db: Client, connection: Row, claimed: Row) => Promise<SourceAdapter>;
};

const simulatedOnly: AdapterFor = {
  live: false,
  build: async (_db, connection, claimed) =>
    adapterForSimulated(
      connection,
      isScenario(claimed.scenario) ? claimed.scenario : "baseline",
      claimed.resumes as number,
    ),
};

// One flow for the guest route and the owner route. They differ only in which adapters they may
// build, and the guest's can only build simulators.
export async function runSync(c: Context<AppEnv>, adapterFor: AdapterFor = simulatedOnly) {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id") as string);
  const key = requireIdempotencyKey(c);
  const body = await readStrictJson(c, ["scenario", "full"]);
  if (body.full !== undefined && typeof body.full !== "boolean") {
    throw new ApiError(400, "invalid_request", "Bad full flag");
  }
  const input = { scenario: requireScenario(body.scenario), full: body.full === true };
  const hash = await hashHex({ route: "POST /integrations/sync", id, input });
  const out = await withClient(c.env.HYPERDRIVE, async (db) => {
    const ctx = commandContext(db, actor, c.get("requestId"));
    const started = await inWorkspaceTx(db, actor.workspaceId, async () => {
      const connection = await loadConnection(db, actor.workspaceId, id);
      if (connection.mode !== "simulated" && !adapterFor.live) throw forbidden();
      let run: Row | null = null;
      const stored = await idempotent(ctx, key, hash, async () => {
        run = await startRun(ctx, id, input);
        return { status: 202, body: { runId: run.id } };
      });
      return { connection, run, stored };
    });
    const fresh = started.run as Row | null;
    if (fresh) {
      const finished = await stepRun(db, ctx, fresh, () =>
        adapterFor.build(db, started.connection, fresh),
      );
      return { run: runDto(finished), replayed: false };
    }
    const runId = (started.stored.body as { runId: string }).runId;
    const { rows } = await inWorkspaceTx(db, actor.workspaceId, () =>
      db.query("SELECT * FROM app.sync_runs WHERE workspace_id = $1 AND id = $2", [
        actor.workspaceId,
        runId,
      ]),
    );
    return { run: runDto(rows[0]), replayed: true };
  });
  if (out.replayed) c.header("Idempotency-Replayed", "true");
  return c.json(out.run);
}

// Operator recovery: continue from the saved cursor, the only way to continue a failed run.
export async function resumeSync(c: Context<AppEnv>, adapterFor: AdapterFor = simulatedOnly) {
  const actor = c.get("actor");
  const id = canonicalId(c.req.param("id") as string);
  const runId = canonicalId(c.req.param("runId") as string);
  const run = await withClient(c.env.HYPERDRIVE, async (db) => {
    const ctx = commandContext(db, actor, c.get("requestId"));
    const { connection, claimed } = await inWorkspaceTx(db, actor.workspaceId, async () => {
      const connection = await loadConnection(db, actor.workspaceId, id);
      if (connection.mode !== "simulated" && !adapterFor.live) throw forbidden();
      return { connection, claimed: await claimRun(ctx, id, runId) };
    });
    return runDto(await stepRun(db, ctx, claimed, () => adapterFor.build(db, connection, claimed)));
  });
  return c.json(run);
}

export const integrations = new Hono<AppEnv>();

integrations.use("*", requireActor);

integrations.get("/", requireCapability("integrations:read"), async (c) => {
  const { workspaceId } = c.get("actor");
  const items = await withWorkspace(c.env.HYPERDRIVE, workspaceId, async (db) => {
    const { rows } = await db.query(
      "SELECT * FROM app.external_connections WHERE workspace_id = $1 ORDER BY provider",
      [workspaceId],
    );
    const runs = await db.query(
      `SELECT DISTINCT ON (connection_id) * FROM app.sync_runs
        WHERE workspace_id = $1 ORDER BY connection_id, started_at DESC`,
      [workspaceId],
    );
    return rows.map((r) => {
      const run = runs.rows.find((x) => x.connection_id === r.id);
      return { ...connectionDto(r), lastRun: run ? runDto(run) : null };
    });
  });
  return c.json({ items });
});

integrations.get("/:id/runs", requireCapability("integrations:read"), async (c) => {
  const { workspaceId } = c.get("actor");
  const id = canonicalId(c.req.param("id"));
  const items = await withWorkspace(c.env.HYPERDRIVE, workspaceId, async (db) => {
    await loadConnection(db, workspaceId, id);
    const { rows } = await db.query(
      `SELECT * FROM app.sync_runs WHERE workspace_id = $1 AND connection_id = $2
        ORDER BY started_at DESC, id DESC LIMIT 20`,
      [workspaceId, id],
    );
    return rows.map(runDto);
  });
  return c.json({ items });
});

// A live connection never reaches a simulator, and these routes never build anything else, so
// they can't touch a real system whoever calls them (P3-E).
integrations.post("/:id/sync", requireCapability("integrations:sync_simulated"), (c) => runSync(c));

integrations.post("/:id/runs/:runId/resume", requireCapability("integrations:recover"), (c) =>
  resumeSync(c),
);
