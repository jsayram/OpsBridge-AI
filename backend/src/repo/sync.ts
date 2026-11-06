import { hashHex } from "../auth/tokens";
import { type Client, type Db, inWorkspaceTx } from "../db";
import { ApiError, notFound } from "../http/errors";
import type { ErpInvoice, InventoryFact } from "../integrations/mappers";
import { isScenario, type Scenario, scenarioApplies } from "../integrations/scenarios";
import {
  AdapterError,
  FAILURE_POLICY,
  type Page,
  type Provider,
  type SourceAdapter,
  type SourceRecord,
} from "../integrations/types";
import { reconcile } from "./reconciliation";
import { type CommandContext, emitEvent, writeAudit } from "./records";

const LEASE_SECONDS = 60;
const MAX_RESUMES = 5;
const REJECT_SAMPLE = 10;
// Keeps one request inside the platform's limits. A longer run returns "running" and the client
// calls continue, which picks up at the saved cursor. Hosted Workers Free sets this to 1, because
// a whole ERP sync measured about 20 ms of CPU under Node against a 10 ms limit.
export const PAGES_PER_CALL = 8;
export const pagesPerCall = (value: string | undefined) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= PAGES_PER_CALL ? n : PAGES_PER_CALL;
};

type Row = Record<string, unknown>;
type Counts = {
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  stale_skipped: number;
  duplicate_skipped: number;
  unknown_fields_dropped: number;
  rejected: number;
  rejected_sample: { externalId: string; reason: string }[];
  findings_opened: number;
  marked_deleted: number;
};
const zeroCounts = (): Counts => ({
  seen: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  stale_skipped: 0,
  duplicate_skipped: 0,
  unknown_fields_dropped: 0,
  rejected: 0,
  rejected_sample: [],
  findings_opened: 0,
  marked_deleted: 0,
});

export const PROVIDER_LABEL: Record<Provider, string> = {
  crm_simulator: "CRM (simulated)",
  erp_simulator: "ERP Simulator",
  inventory_simulator: "Inventory (simulated)",
  salesforce_test: "Salesforce test org",
};

const stale = () =>
  new ApiError(409, "stale_version", "Someone changed this. Reload and try again.");
const inProgress = () =>
  new ApiError(409, "sync_in_progress", "A sync is already running for this source.");

export function runDto(r: Row) {
  const failure = r.error_class as keyof typeof FAILURE_POLICY | null;
  return {
    id: r.id,
    provider: r.provider,
    kind: r.kind,
    scenario: r.scenario,
    status: r.status,
    pages: r.pages,
    counts: r.counts,
    resumes: r.resumes,
    resumable:
      (r.status === "failed" || r.status === "dead_letter") && (r.resumes as number) < MAX_RESUMES,
    error: failure
      ? {
          class: failure,
          code: r.error_code,
          message: FAILURE_POLICY[failure].message,
          state: r.status === "dead_letter" ? "dead_letter" : "failed",
        }
      : null,
    cursorSaved: r.cursor !== null,
    startedAt: (r.started_at as Date).toISOString(),
    endedAt: (r.ended_at as Date | null)?.toISOString() ?? null,
  };
}

const CONNECTION_COLUMNS = `id, provider, mode, status, last_cursor, last_success_at, last_error_code,
  version, created_at, scopes, EXTRACT(EPOCH FROM simulator_shift) * 1000 AS shift_ms`;

export async function loadConnection(db: Db, workspaceId: string, id: string): Promise<Row> {
  const { rows } = await db.query(
    `SELECT ${CONNECTION_COLUMNS} FROM app.external_connections WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

const lockConnection = async (db: Db, workspaceId: string, id: string) => {
  const { rows } = await db.query(
    `SELECT ${CONNECTION_COLUMNS} FROM app.external_connections
      WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [workspaceId, id],
  );
  if (!rows[0]) throw notFound();
  return rows[0] as Row;
};

const closeAbandoned = (db: Db, workspaceId: string, connectionId: string) =>
  db.query(
    `UPDATE app.sync_runs
        SET status = 'failed', error_class = 'transient', error_code = 'lease_expired',
            ended_at = now(), lease_token = NULL
      WHERE workspace_id = $1 AND connection_id = $2 AND status = 'running'
        AND lease_expires_at < now()`,
    [workspaceId, connectionId],
  );

// Runs inside the idempotency transaction, so a repeat of the request finds this run instead of
// starting another.
export async function startRun(
  ctx: CommandContext,
  connectionId: string,
  input: { scenario: Scenario; full: boolean },
) {
  const connection = await lockConnection(ctx.db, ctx.workspaceId, connectionId);
  const provider = connection.provider as Provider;
  if (!scenarioApplies(input.scenario, provider)) {
    throw new ApiError(400, "invalid_request", "That scenario doesn't apply to this source");
  }
  if (connection.status === "Disconnected" || connection.status === "Not Configured") {
    throw new ApiError(409, "not_connected", "This source isn't connected.");
  }
  await closeAbandoned(ctx.db, ctx.workspaceId, connectionId);
  // Scenarios replace the whole source picture, so they always read all of it.
  const full = input.full || input.scenario !== "baseline" || !connection.last_cursor;
  const token = crypto.randomUUID();
  const { rows } = await ctx.db
    .query(
      `INSERT INTO app.sync_runs (workspace_id, connection_id, provider, kind, scenario, since_cursor,
                                  counts, lease_token, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9)) RETURNING *`,
      [
        ctx.workspaceId,
        connectionId,
        provider,
        full ? "full" : "delta",
        input.scenario,
        full ? null : connection.last_cursor,
        JSON.stringify(zeroCounts()),
        token,
        LEASE_SECONDS,
      ],
    )
    .catch((e) => {
      if (e.code === "23505") throw inProgress();
      throw e;
    });
  await writeAudit(ctx, "sync.started", connectionId, {
    summary: `${PROVIDER_LABEL[provider]}: ${full ? "full" : "delta"} sync started, scenario ${input.scenario}`,
  });
  return rows[0] as Row;
}

export async function claimRun(
  ctx: CommandContext,
  connectionId: string,
  runId: string,
  intent: "continue" | "resume" = "resume",
) {
  await lockConnection(ctx.db, ctx.workspaceId, connectionId);
  const { rows } = await ctx.db.query(
    `SELECT *, lease_expires_at > now() AS lease_live FROM app.sync_runs
      WHERE workspace_id = $1 AND id = $2 AND connection_id = $3 FOR UPDATE`,
    [ctx.workspaceId, runId, connectionId],
  );
  const run = rows[0] as Row | undefined;
  if (!run) throw notFound();
  if (run.status === "succeeded") {
    throw new ApiError(409, "run_finished", "This sync already finished.");
  }
  const token = crypto.randomUUID();
  if (run.status === "running") {
    if (run.lease_live) throw inProgress();
    const { rows: taken } = await ctx.db.query(
      `UPDATE app.sync_runs SET lease_token = $3, lease_expires_at = now() + make_interval(secs => $4)
        WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      [ctx.workspaceId, runId, token, LEASE_SECONDS],
    );
    return taken[0] as Row;
  }
  // Continuing only carries on a healthy run. Reopening a failed one is an operator's decision.
  if (intent === "continue") {
    throw new ApiError(409, "resume_required", "This run failed. An operator has to resume it.");
  }
  if ((run.resumes as number) >= MAX_RESUMES) {
    throw new ApiError(
      409,
      "retry_exhausted",
      "This run has been retried enough. Start a new sync.",
    );
  }
  const { rows: reopened } = await ctx.db
    .query(
      `UPDATE app.sync_runs
          SET status = 'running', error_class = NULL, error_code = NULL, ended_at = NULL,
              resumes = resumes + 1, lease_token = $3,
              lease_expires_at = now() + make_interval(secs => $4)
        WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      [ctx.workspaceId, runId, token, LEASE_SECONDS],
    )
    .catch((e) => {
      if (e.code === "23505") throw inProgress();
      throw e;
    });
  const run2 = reopened[0] as Row;
  await writeAudit(ctx, "sync.resumed", connectionId, {
    summary: `${PROVIDER_LABEL[run2.provider as Provider]}: operator resumed the run from the saved cursor`,
  });
  return run2;
}

const TYPES_FOR_DELETE = ["organization", "customer"];

async function applySource(ctx: CommandContext, run: Row, records: SourceRecord[], counts: Counts) {
  const newest = new Map<string, SourceRecord>();
  for (const r of records) {
    const key = `${r.stream}|${r.externalId}`;
    const held = newest.get(key);
    if (!held) newest.set(key, r);
    else {
      counts.duplicate_skipped++;
      if (r.sourceModifiedAt > held.sourceModifiedAt) newest.set(key, r);
    }
  }
  for (const r of newest.values()) {
    const hash = await hashHex(r.data);
    const held = (
      await ctx.db.query(
        `SELECT content_hash, source_modified_at, last_seen_run FROM app.source_records
          WHERE workspace_id = $1 AND provider = $2 AND external_type = $3 AND external_id = $4
          FOR UPDATE`,
        [ctx.workspaceId, run.provider, r.stream, r.externalId],
      )
    ).rows[0] as Row | undefined;
    const incoming = Date.parse(r.sourceModifiedAt);
    const known = held ? (held.source_modified_at as Date).getTime() : null;
    if (!held || known === null) {
      await ctx.db.query(
        `INSERT INTO app.source_records (workspace_id, connection_id, provider, external_type, external_id,
           external_version, source_modified_at, observed_at, content_hash, data, last_seen_run)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          ctx.workspaceId,
          run.connection_id,
          run.provider,
          r.stream,
          r.externalId,
          r.externalVersion,
          r.sourceModifiedAt,
          r.observedAt,
          hash,
          JSON.stringify(r.data),
          run.id,
        ],
      );
      counts.created++;
      continue;
    }
    if (incoming < known) counts.stale_skipped++;
    else if (held.content_hash === hash) {
      if (held.last_seen_run === run.id) counts.duplicate_skipped++;
      else counts.unchanged++;
    } else {
      await ctx.db.query(
        `UPDATE app.source_records
            SET external_version = $5, source_modified_at = $6, observed_at = $7, content_hash = $8,
                data = $9, state = 'active', last_seen_run = $10
          WHERE workspace_id = $1 AND provider = $2 AND external_type = $3 AND external_id = $4`,
        [
          ctx.workspaceId,
          run.provider,
          r.stream,
          r.externalId,
          r.externalVersion,
          r.sourceModifiedAt,
          r.observedAt,
          hash,
          JSON.stringify(r.data),
          run.id,
        ],
      );
      counts.updated++;
      continue;
    }
    // Seen in this read, even when older or the same. Deletion detection depends on it.
    await ctx.db.query(
      `UPDATE app.source_records SET last_seen_run = $5, state = 'active'
        WHERE workspace_id = $1 AND provider = $2 AND external_type = $3 AND external_id = $4`,
      [ctx.workspaceId, run.provider, r.stream, r.externalId, run.id],
    );
  }
  await ctx.db.query(
    `UPDATE app.external_record_links SET last_seen = now()
      WHERE workspace_id = $1 AND provider = $2 AND external_type = ANY($3) AND external_id = ANY($4)`,
    [
      ctx.workspaceId,
      run.provider,
      [...new Set(records.map((r) => r.stream))],
      records.map((r) => r.externalId),
    ],
  );
}

async function applyInvoices(
  ctx: CommandContext,
  run: Row,
  records: SourceRecord[],
  counts: Counts,
) {
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.externalId)) {
      counts.duplicate_skipped++;
      continue;
    }
    seen.add(r.externalId);
    const d = r.data as ErpInvoice;
    const held = (
      await ctx.db.query(
        `SELECT source_modified_at, amount::text AS amount, status, tran_number FROM app.invoices
          WHERE workspace_id = $1 AND provider = $2 AND external_id = $3 FOR UPDATE`,
        [ctx.workspaceId, run.provider, r.externalId],
      )
    ).rows[0] as Row | undefined;
    if (held) {
      const known = (held.source_modified_at as Date).getTime();
      const same =
        held.amount === Number(d.amount).toFixed(2) &&
        held.status === d.status &&
        held.tran_number === d.tranNumber;
      if (Date.parse(r.sourceModifiedAt) < known) {
        counts.stale_skipped++;
        continue;
      }
      if (same) {
        counts.unchanged++;
        continue;
      }
    }
    const { rows } = await ctx.db.query(
      `INSERT INTO app.invoices (workspace_id, provider, external_id, tran_number, bill_to_external_id,
         customer_id, amount, currency, tran_date, status, source_modified_at)
       VALUES ($1, $2, $3, $4, $5,
         (SELECT canonical_id FROM app.external_record_links
           WHERE workspace_id = $1 AND provider = $2 AND external_type = 'customer' AND external_id = $5),
         $6, $7, $8, $9, $10)
       ON CONFLICT (workspace_id, provider, external_id) DO UPDATE
         SET tran_number = EXCLUDED.tran_number, amount = EXCLUDED.amount, status = EXCLUDED.status,
             source_modified_at = EXCLUDED.source_modified_at
       RETURNING (xmax = 0) AS inserted`,
      [
        ctx.workspaceId,
        run.provider,
        r.externalId,
        d.tranNumber,
        d.billToExternalId,
        d.amount,
        d.currency,
        d.tranDate,
        d.status,
        r.sourceModifiedAt,
      ],
    );
    if (rows[0].inserted) counts.created++;
    else counts.updated++;
  }
}

// Read-only source facts. A snapshot row is added or ignored; nothing here can change a quantity
// that is already recorded, and no item is ever created.
async function applyInventory(
  ctx: CommandContext,
  run: Row,
  records: SourceRecord[],
  counts: Counts,
) {
  for (const r of records) {
    const d = r.data as InventoryFact;
    const item = (
      await ctx.db.query(
        "SELECT id FROM app.inventory_items WHERE workspace_id = $1 AND canonical_item_code = $2",
        [ctx.workspaceId, d.itemCode],
      )
    ).rows[0] as Row | undefined;
    const newest = (
      await ctx.db.query(
        `SELECT max(source_version) AS v FROM app.inventory_snapshots
          WHERE workspace_id = $1 AND provider = $2 AND external_id = $3`,
        [ctx.workspaceId, run.provider, r.externalId],
      )
    ).rows[0] as Row;
    const { rowCount } = await ctx.db.query(
      `INSERT INTO app.inventory_snapshots (workspace_id, item_id, unresolved_source_ref, provider,
         external_id, quantity, unit, source_version, observed_at, location, item_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (workspace_id, provider, external_id, source_version) DO NOTHING`,
      [
        ctx.workspaceId,
        item?.id ?? null,
        item ? null : d.itemCode,
        run.provider,
        r.externalId,
        d.quantity,
        d.unit,
        d.version,
        r.sourceModifiedAt,
        d.location,
        d.itemCode,
      ],
    );
    if (rowCount === 0) counts.unchanged++;
    else if (newest.v !== null && (newest.v as number) > d.version) counts.stale_skipped++;
    else counts.created++;
    if (item) {
      await ctx.db.query(
        `INSERT INTO app.external_record_links (workspace_id, provider, external_type, external_id,
           canonical_type, canonical_id, last_seen)
         VALUES ($1, $2, 'inventory_snapshot', $3, 'inventory_item', $4, now())
         ON CONFLICT (workspace_id, provider, external_type, external_id)
           DO UPDATE SET last_seen = now()
           WHERE app.external_record_links.canonical_id = EXCLUDED.canonical_id`,
        [ctx.workspaceId, run.provider, r.externalId, item.id],
      );
    }
  }
}

async function applyPage(ctx: CommandContext, run: Row, page: Page, counts: Counts) {
  const of = (stream: string) => page.items.filter((r) => r.stream === stream);
  counts.seen += page.items.length;
  counts.unknown_fields_dropped += page.stats.unknownFields;
  counts.rejected += page.stats.rejected.length;
  counts.rejected_sample = [...counts.rejected_sample, ...page.stats.rejected].slice(
    0,
    REJECT_SAMPLE,
  );
  const source = [...of("organization"), ...of("customer")];
  if (source.length > 0) await applySource(ctx, run, source, counts);
  if (of("invoice").length > 0) await applyInvoices(ctx, run, of("invoice"), counts);
  if (of("inventory_snapshot").length > 0) {
    await applyInventory(ctx, run, of("inventory_snapshot"), counts);
  }
}

const lockRun = async (ctx: CommandContext, runId: string, token: unknown) => {
  const { rows } = await ctx.db.query(
    "SELECT * FROM app.sync_runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    [ctx.workspaceId, runId],
  );
  const run = rows[0] as Row | undefined;
  // Someone else took over after our lease ran out. Stop without writing anything.
  if (run?.status !== "running" || run.lease_token !== token) throw stale();
  return run;
};

// Connection, then run: the same order as startRun and claimRun.
async function finishSuccess(
  ctx: CommandContext,
  connectionId: string,
  runId: string,
  token: unknown,
) {
  const connection = await lockConnection(ctx.db, ctx.workspaceId, connectionId);
  const run = await lockRun(ctx, runId, token);
  const counts = run.counts as Counts;
  if (run.kind === "full" && counts.seen > 0) {
    const gone = await ctx.db.query(
      `UPDATE app.source_records SET state = 'deleted'
        WHERE workspace_id = $1 AND connection_id = $2 AND state = 'active' AND last_seen_run <> $3
          AND external_type = ANY($4)`,
      [ctx.workspaceId, run.connection_id, run.id, TYPES_FOR_DELETE],
    );
    counts.marked_deleted = gone.rowCount ?? 0;
  }
  counts.findings_opened = await reconcile(ctx);
  const watermark = (run.high_watermark as Date | null)?.toISOString() ?? connection.last_cursor;
  const healed = connection.mode === "connected_test" ? "Connected Test" : "Simulated";
  await ctx.db.query(
    `UPDATE app.external_connections
        SET last_cursor = $3, last_success_at = now(), last_error_code = NULL, status = $4,
            version = version + 1
      WHERE workspace_id = $1 AND id = $2`,
    [ctx.workspaceId, run.connection_id, watermark, healed],
  );
  const { rows } = await ctx.db.query(
    `UPDATE app.sync_runs SET status = 'succeeded', ended_at = now(), counts = $3, lease_token = NULL
      WHERE workspace_id = $1 AND id = $2 RETURNING *`,
    [ctx.workspaceId, runId, JSON.stringify(counts)],
  );
  await writeAudit(ctx, "sync.finished", run.connection_id as string, {
    summary: `${PROVIDER_LABEL[run.provider as Provider]}: ${counts.seen} seen, ${counts.created} new, ${counts.updated} changed, ${counts.unchanged} unchanged, ${counts.stale_skipped} stale, ${counts.findings_opened} findings opened`,
  });
  return rows[0] as Row;
}

async function finishFailure(
  ctx: CommandContext,
  connectionId: string,
  runId: string,
  token: unknown,
  e: AdapterError,
) {
  const connection = await lockConnection(ctx.db, ctx.workspaceId, connectionId);
  const run = await lockRun(ctx, runId, token);
  const policy = FAILURE_POLICY[e.failure];
  const { rows } = await ctx.db.query(
    `UPDATE app.sync_runs
        SET status = $3, error_class = $4, error_code = $5, ended_at = now(), lease_token = NULL
      WHERE workspace_id = $1 AND id = $2 RETURNING *`,
    [ctx.workspaceId, runId, policy.run, e.failure, e.code],
  );
  await ctx.db.query(
    `UPDATE app.external_connections SET status = 'Degraded', last_error_code = $3, version = version + 1
      WHERE workspace_id = $1 AND id = $2`,
    [ctx.workspaceId, run.connection_id, e.code],
  );
  const provider = run.provider as Provider;
  if (connection.status !== "Degraded") {
    await emitEvent(
      ctx,
      "integration.degraded",
      `integration:${run.connection_id}:degraded:${run.id}:${run.resumes}`,
      provider,
      { provider, status: "degraded" },
    );
  }
  await writeAudit(
    ctx,
    policy.run === "dead_letter" ? "sync.dead_lettered" : "sync.failed",
    run.connection_id as string,
    {
      summary: `${PROVIDER_LABEL[provider]}: ${e.code} after ${run.pages} pages. Saved cursor kept.`,
    },
  );
  return rows[0] as Row;
}

export type StepHooks = { beforeCursorCommit?: () => void | Promise<void> };

// Reads pages from the source and commits each one with the cursor that follows it, in its own
// short transaction. The network call sits between transactions, never inside one.
export async function stepRun(
  client: Client,
  ctx: CommandContext,
  claimed: Row,
  getAdapter: () => Promise<SourceAdapter>,
  hooks: StepHooks = {},
  pagesPerCall = PAGES_PER_CALL,
): Promise<Row> {
  const tx = <T>(fn: () => Promise<T>) => inWorkspaceTx(client, ctx.workspaceId, fn);
  const token = claimed.lease_token;
  const runId = claimed.id as string;
  const connectionId = claimed.connection_id as string;
  let cursor = claimed.cursor as string | null;
  // Built here so a missing token fails the run like any other source failure, not half-way.
  let adapter: SourceAdapter;
  try {
    adapter = await getAdapter();
  } catch (e) {
    if (!(e instanceof AdapterError)) throw e;
    return tx(() => finishFailure(ctx, connectionId, runId, token, e));
  }
  for (let step = 0; step < pagesPerCall; step++) {
    let page: Page;
    try {
      page = await adapter.list({
        limit: adapter.pageSize,
        ...(cursor !== null ? { cursor } : {}),
        ...(claimed.since_cursor ? { since: claimed.since_cursor as string } : {}),
      });
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e;
      return tx(() => finishFailure(ctx, connectionId, runId, token, e));
    }
    const done = page.nextCursor === undefined;
    await tx(async () => {
      const run = await lockRun(ctx, runId, token);
      if (run.cursor !== cursor) throw stale();
      const counts = { ...zeroCounts(), ...(run.counts as Partial<Counts>) };
      await applyPage(ctx, run, page, counts);
      await hooks.beforeCursorCommit?.();
      await ctx.db.query(
        `UPDATE app.sync_runs
            SET cursor = $3, pages = pages + 1, counts = $4,
                high_watermark = GREATEST(high_watermark, $5::timestamptz),
                lease_expires_at = now() + make_interval(secs => $6)
          WHERE workspace_id = $1 AND id = $2`,
        [
          ctx.workspaceId,
          runId,
          page.nextCursor ?? cursor,
          JSON.stringify(counts),
          page.highWatermark,
          LEASE_SECONDS,
        ],
      );
    });
    if (done) return tx(() => finishSuccess(ctx, connectionId, runId, token));
    cursor = page.nextCursor as string;
  }
  // Out of pages for this call. The run stays open for resume, at no wait.
  return tx(async () => {
    const { rows } = await ctx.db.query(
      `UPDATE app.sync_runs SET lease_expires_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      [ctx.workspaceId, runId],
    );
    return rows[0] as Row;
  });
}

export const requireScenario = (value: unknown): Scenario => {
  if (value === undefined) return "baseline";
  if (!isScenario(value)) throw new ApiError(400, "invalid_request", "Bad scenario");
  return value;
};
