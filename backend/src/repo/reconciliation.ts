import type { Db } from "../db";
import { findingRef } from "../domain/events";
import {
  canAdvance,
  decisionTarget,
  type FindingDecision,
  type FindingStatus,
  isOpenState,
  MAX_DEFER_DAYS,
} from "../domain/findingStatus";
import { RULES } from "../domain/glossary";
import {
  detectFindings,
  type Evidence,
  type Resolution,
  type SourceFact,
} from "../domain/reconcile";
import { ApiError, forbidden, invalidRequest, notFound } from "../http/errors";
import { type CommandContext, emitEvent, writeAudit } from "./records";

type Row = Record<string, unknown>;

const TEMPLATE_ID = "(SELECT id FROM app.workspaces WHERE mode = 'template')";
const COLUMNS = `f.id, f.entity_type, f.entity_id, f.kind, f.severity, f.source_values, f.status, f.defer_until,
  f.version, f.resolved_at, f.resolved_by, f.resolution_note, f.supersedes_id, f.subject, f.proposal, f.detected_at,
  f.workspace_id <> $1 AS read_only,
  c.canonical_name AS customer,
  EXISTS (SELECT FROM app.reconciliation_findings n
           WHERE n.workspace_id = f.workspace_id AND n.supersedes_id = f.id) AS superseded`;
const FROM = `FROM app.reconciliation_findings f
  LEFT JOIN app.customers c
    ON f.entity_type = 'customer' AND c.workspace_id = f.workspace_id AND c.id = f.entity_id`;

export const findingDto = (r: Row) => {
  const evidence = r.source_values as Evidence;
  return {
    id: r.id,
    ref: `F-${(r.id as string).slice(0, 8).toUpperCase()}`,
    kind: r.kind,
    severity: r.severity,
    status: r.status,
    version: r.version,
    customer: r.customer ?? null,
    subject: r.subject,
    proposal: r.proposal,
    deferUntil: (r.defer_until as Date | null)?.toISOString() ?? null,
    detectedAt: (r.detected_at as Date).toISOString(),
    resolvedAt: (r.resolved_at as Date | null)?.toISOString() ?? null,
    resolvedBy: r.resolved_by,
    resolutionNote: r.resolution_note,
    supersedes: r.supersedes_id,
    superseded: r.superseded,
    readOnly: r.read_only,
    evidence: {
      sources: evidence.sources,
      differences: evidence.differences,
      matchBasis: evidence.matchBasis,
      explanation: evidence.explanation,
      recommendedAction: evidence.recommendedAction,
      rule: evidence.ruleRef
        ? { ref: evidence.ruleRef, text: RULES[evidence.ruleRef as keyof typeof RULES] ?? null }
        : null,
      normalization: evidence.normalization,
      needsTarget:
        evidence.resolution.type === "link_or_create" &&
        evidence.resolution.suggestedCustomerId !== null,
      suggestedCustomerId:
        evidence.resolution.type === "link_or_create"
          ? evidence.resolution.suggestedCustomerId
          : null,
    },
  };
};

export type FindingQuery = {
  workspaceId: string;
  shared: boolean;
  status?: FindingStatus;
  limit: number;
  before?: { at: string; id: string };
};

export async function listFindings(db: Db, q: FindingQuery) {
  const owner = q.shared ? TEMPLATE_ID : "$1::uuid";
  // sast-ok: owner is one of two constant fragments
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM}
      WHERE f.workspace_id = ${owner} AND ($2::text IS NULL OR f.status = $2)
        AND ($3::timestamptz IS NULL OR (f.detected_at, f.id) < ($3, $4::uuid))
      ORDER BY f.detected_at DESC, f.id DESC LIMIT $5`,
    [q.workspaceId, q.status ?? null, q.before?.at ?? null, q.before?.id ?? null, q.limit + 1],
  );
  const page = rows.slice(0, q.limit);
  const last = page.at(-1) as Row | undefined;
  return {
    items: page.map(findingDto),
    ...(rows.length > q.limit && last
      ? { nextCursor: `${(last.detected_at as Date).toISOString()}_${last.id}` }
      : {}),
  };
}

export async function findFinding(db: Db, workspaceId: string, seesTemplate: boolean, id: string) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} ${FROM}
      WHERE f.id = $2 AND (f.workspace_id = $1 OR ($3 AND f.workspace_id = ${TEMPLATE_ID}))`,
    [workspaceId, id, seesTemplate],
  );
  return rows[0] as Row | undefined;
}

// Same order for every finding command: the finding, then any customer it touches. No finding
// command touches a case, so the case-first rule from D-031 is never in play.
async function lockedFinding(
  ctx: CommandContext,
  seesTemplate: boolean,
  id: string,
  version: number,
) {
  const seen = await findFinding(ctx.db, ctx.workspaceId, seesTemplate, id);
  if (!seen) throw notFound();
  if (seen.read_only) throw forbidden();
  await ctx.db.query(
    "SELECT 1 FROM app.reconciliation_findings WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    [ctx.workspaceId, id],
  );
  const row = (await findFinding(ctx.db, ctx.workspaceId, false, id)) as Row;
  if (row.version !== version) {
    throw new ApiError(409, "stale_version", "Someone changed this finding. Reload and try again.");
  }
  return row;
}

const invalidTransition = (message: string) => new ApiError(409, "invalid_transition", message);
const evidenceStale = () =>
  new ApiError(
    409,
    "evidence_stale",
    "The record changed since this finding was raised. Run a sync and review again.",
  );

export async function advanceFinding(
  ctx: CommandContext,
  seesTemplate: boolean,
  id: string,
  input: { to: FindingStatus; version: number; proposal?: string },
) {
  const row = await lockedFinding(ctx, seesTemplate, id, input.version);
  const from = row.status as FindingStatus;
  if (!canAdvance(from, input.to)) throw invalidTransition("That status change isn't allowed.");
  if (input.to === "Proposed" && !input.proposal) {
    throw invalidRequest("Write down what you propose");
  }
  await ctx.db.query(
    `UPDATE app.reconciliation_findings
        SET status = $3, version = version + 1, defer_until = NULL, proposal = coalesce($4, proposal)
      WHERE workspace_id = $1 AND id = $2`,
    [ctx.workspaceId, id, input.to, input.proposal ?? null],
  );
  await writeAudit(ctx, "finding.advanced", id, {
    before: { status: from },
    after: { status: input.to },
    summary: `${row.kind}: ${from} to ${input.to}`,
  });
  return findingDto((await findFinding(ctx.db, ctx.workspaceId, false, id)) as Row);
}

const ROLE_FOR: Record<string, string> = {
  crm_simulator: "crm_organization",
  salesforce_test: "crm_organization",
  erp_simulator: "erp_bill_to",
};

async function addLink(
  ctx: CommandContext,
  link: { provider: string; externalType: string; externalId: string; customerId: string },
  mappingVersion: string,
) {
  const { rows } = await ctx.db.query(
    `INSERT INTO app.external_record_links (workspace_id, provider, external_type, external_id,
       canonical_type, canonical_id, last_seen)
     VALUES ($1, $2, $3, $4, 'customer', $5, now())
     ON CONFLICT (workspace_id, provider, external_type, external_id) DO UPDATE SET last_seen = now()
     RETURNING id, canonical_id`,
    [ctx.workspaceId, link.provider, link.externalType, link.externalId, link.customerId],
  );
  const row = rows[0] as Row;
  // A link that already points at another customer stands. Someone decided that one.
  if (row.canonical_id !== link.customerId) throw evidenceStale();
  await ctx.db.query(
    `INSERT INTO app.customer_source_relationships (workspace_id, customer_id, external_record_link_id,
       relationship_role, mapping_version, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, now()) ON CONFLICT DO NOTHING`,
    [
      ctx.workspaceId,
      link.customerId,
      row.id,
      ROLE_FOR[link.provider] ?? "erp_bill_to",
      mappingVersion,
      ctx.actorRole,
    ],
  );
  if (link.provider === "erp_simulator") {
    await ctx.db.query(
      `UPDATE app.invoices SET customer_id = $3
        WHERE workspace_id = $1 AND provider = 'erp_simulator' AND bill_to_external_id = $2`,
      [ctx.workspaceId, link.externalId, link.customerId],
    );
  }
}

const lockCustomer = async (ctx: CommandContext, id: string) => {
  const { rows } = await ctx.db.query(
    `SELECT id, canonical_name, account_code FROM app.customers
      WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [ctx.workspaceId, id],
  );
  return rows[0] as Row | undefined;
};

// The evidence is a claim about the source at detection time. Before acting on it, check that the
// newest stored read still says so. No stored read at all means nothing has contradicted it yet.
async function assertSourceStill(
  ctx: CommandContext,
  externalIds: string[],
  field?: { name: "name" | "accountNumber"; value: string },
) {
  const { rows } = await ctx.db.query(
    `SELECT external_id, state, data FROM app.source_records
      WHERE workspace_id = $1 AND provider = 'erp_simulator' AND external_type = 'customer'
        AND external_id = ANY($2)`,
    [ctx.workspaceId, externalIds],
  );
  for (const row of rows) {
    if (row.state !== "active") throw evidenceStale();
    if (field && row.data[field.name] !== field.value) throw evidenceStale();
  }
}

// The only code that changes canonical data because of a finding. It runs inside the resolve
// transaction, touches only this workspace's rows, and never calls a source.
async function applyResolution(
  ctx: CommandContext,
  row: Row,
  r: Resolution,
  targetCustomerId?: string,
) {
  const customerId = row.entity_id as string | null;
  switch (r.type) {
    case "acknowledge":
      return "Reviewed. No canonical record changed.";
    case "link_bill_tos": {
      if (!customerId || !(await lockCustomer(ctx, customerId))) throw evidenceStale();
      await assertSourceStill(ctx, r.externalIds);
      const version = `${r.ruleRef}/customer-1`;
      for (const externalId of r.externalIds) {
        await addLink(
          ctx,
          { provider: "erp_simulator", externalType: "customer", externalId, customerId },
          version,
        );
      }
      await ctx.db.query(
        `INSERT INTO app.source_definition_mappings (workspace_id, provider, entity_type,
           source_definition_version, canonical_definition_version, mapping_rule_ref, field_authority,
           steward_role, approved_by, approved_at, rationale)
         VALUES ($1, 'erp_simulator', 'customer', 'erp-customer-1', 'customer-1', $2, $3, $4, $5, now(), $6)`,
        [
          ctx.workspaceId,
          r.ruleRef,
          JSON.stringify({
            legalName: "erp",
            billing: "erp",
            salesStage: "crm",
            everythingElse: "steward",
          }),
          "Finance lead (fictional role)",
          ctx.actorRole,
          (row.proposal as string | null) ?? "One organization, several billable entities",
        ],
      );
      return `Mapped ${r.externalIds.length} bill-tos under one customer.`;
    }
    case "set_canonical_name": {
      const customer = customerId ? await lockCustomer(ctx, customerId) : undefined;
      if (customer?.canonical_name !== r.from) throw evidenceStale();
      await assertSourceStill(ctx, [r.externalId], { name: "name", value: r.to });
      await ctx.db.query(
        `UPDATE app.customers SET canonical_name = $3, version = version + 1
          WHERE workspace_id = $1 AND id = $2`,
        [ctx.workspaceId, customerId, r.to],
      );
      return "Canonical name set to the ERP legal name.";
    }
    case "set_account_code": {
      const customer = customerId ? await lockCustomer(ctx, customerId) : undefined;
      if (customer?.account_code !== r.from) throw evidenceStale();
      await assertSourceStill(ctx, [r.externalId], { name: "accountNumber", value: r.to });
      await ctx.db.query(
        `UPDATE app.customers SET account_code = $3, version = version + 1
          WHERE workspace_id = $1 AND id = $2`,
        [ctx.workspaceId, customerId, r.to],
      );
      return "Canonical account set to the ERP account.";
    }
    case "link_or_create": {
      // A name match can suggest a customer, and only a person's explicit choice can use it.
      if (r.suggestedCustomerId && !targetCustomerId) {
        throw invalidRequest("Choose the customer to link, after checking it is the same entity");
      }
      if (r.provider === "erp_simulator") await assertSourceStill(ctx, [r.externalId]);
      let target = targetCustomerId;
      if (target) {
        if (!(await lockCustomer(ctx, target))) throw notFound();
      } else {
        const { rows } = await ctx.db.query(
          `INSERT INTO app.customers (workspace_id, canonical_name, account_code, lifecycle_status)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [ctx.workspaceId, r.name, r.accountCode, r.lifecycle],
        );
        target = rows[0].id as string;
      }
      await addLink(
        ctx,
        {
          provider: r.provider,
          externalType: r.externalType,
          externalId: r.externalId,
          customerId: target,
        },
        "R-CUST-1/customer-1",
      );
      await ctx.db.query(
        `UPDATE app.reconciliation_findings SET entity_type = 'customer', entity_id = $3
          WHERE workspace_id = $1 AND id = $2`,
        [ctx.workspaceId, row.id, target],
      );
      return targetCustomerId
        ? "Linked to the chosen customer."
        : "Created a canonical customer and linked it.";
    }
  }
}

export async function resolveFinding(
  ctx: CommandContext,
  seesTemplate: boolean,
  id: string,
  input: {
    decision: FindingDecision;
    version: number;
    reason?: string;
    deferUntil?: string;
    targetCustomerId?: string;
  },
) {
  const row = await lockedFinding(ctx, seesTemplate, id, input.version);
  const from = row.status as FindingStatus;
  const to = decisionTarget(from, input.decision);
  if (!to) {
    throw invalidTransition(
      input.decision === "approve"
        ? "Only a proposed finding can be approved."
        : "This finding is already closed.",
    );
  }
  let note: string | undefined = input.reason;
  if (input.decision === "reject" && !input.reason) throw invalidRequest("A reason is required");
  if (input.decision === "defer") {
    const until = input.deferUntil ? Date.parse(input.deferUntil) : Number.NaN;
    const now = Date.now();
    if (Number.isNaN(until) || until <= now || until > now + MAX_DEFER_DAYS * 86_400_000) {
      throw invalidRequest(`Choose a date within ${MAX_DEFER_DAYS} days`);
    }
  }
  if (input.decision === "approve") {
    if (row.superseded) {
      throw new ApiError(409, "finding_superseded", "Newer source evidence replaced this finding.");
    }
    note = await applyResolution(
      ctx,
      row,
      (row.source_values as Evidence).resolution,
      input.targetCustomerId,
    );
  }
  const closes = to === "Resolved" || to === "Dismissed";
  await ctx.db.query(
    `UPDATE app.reconciliation_findings
        SET status = $3, version = version + 1, defer_until = $4, resolved_at = $5,
            resolved_by = $6, resolution_note = $7
      WHERE workspace_id = $1 AND id = $2`,
    [
      ctx.workspaceId,
      id,
      to,
      input.decision === "defer" ? input.deferUntil : null,
      closes ? new Date().toISOString() : null,
      closes ? ctx.actorRole : null,
      note ?? null,
    ],
  );
  await writeAudit(
    ctx,
    `finding.${input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "deferred"}`,
    id,
    {
      before: { status: from },
      after: { status: to },
      summary: `${row.kind}: ${from} to ${to}${note ? `. ${note}` : ""}`.slice(0, 800),
    },
  );
  if (input.decision === "approve") {
    const ref = await findingRef(id);
    await emitEvent(ctx, "reconciliation.resolved", `finding:${id}:resolved`, ref, {
      findingRef: ref,
      kind: row.kind as string,
    });
  }
  return findingDto((await findFinding(ctx.db, ctx.workspaceId, false, id)) as Row);
}

const MAX_FACTS = 1000;

// Called inside the transaction that finishes a sync. A replay of the same facts changes nothing:
// the key already exists. A closed finding is never reopened; changed evidence is a new row that
// links back to the one it replaces.
export async function reconcile(
  ctx: CommandContext,
): Promise<{ opened: number; skipped: boolean }> {
  const w = [ctx.workspaceId];
  const sources = await ctx.db.query(
    `SELECT provider, external_type, external_id, external_version, source_modified_at, state, data
       FROM app.source_records WHERE workspace_id = $1
      ORDER BY provider, external_type, external_id LIMIT ${MAX_FACTS}`,
    w,
  );
  const customers = await ctx.db.query(
    `SELECT id, canonical_name, account_code, lifecycle_status FROM app.customers
      WHERE workspace_id = $1 ORDER BY id LIMIT ${MAX_FACTS}`,
    w,
  );
  const links = await ctx.db.query(
    `SELECT provider, external_type, external_id, canonical_id FROM app.external_record_links
      WHERE workspace_id = $1 AND canonical_type = 'customer' ORDER BY id LIMIT ${MAX_FACTS}`,
    w,
  );
  const items = await ctx.db.query(
    `SELECT id, canonical_item_code, canonical_unit FROM app.inventory_items
      WHERE workspace_id = $1 ORDER BY id LIMIT ${MAX_FACTS}`,
    w,
  );
  const snapshots = await ctx.db.query(
    `SELECT external_id, item_code, item_id, trim_scale(quantity)::text AS quantity, unit, source_version,
            observed_at, location
       FROM app.inventory_snapshots WHERE workspace_id = $1 ORDER BY id LIMIT ${MAX_FACTS}`,
    w,
  );
  // A partial picture would call everything past the cap unmapped. Better to say nothing.
  if ([sources, customers, links, items, snapshots].some((r) => r.rows.length >= MAX_FACTS)) {
    return { opened: 0, skipped: true };
  }
  const { findings, exactLinks } = detectFindings({
    now: new Date().toISOString(),
    sources: sources.rows.map(
      (s): SourceFact => ({
        provider: s.provider,
        externalType: s.external_type,
        externalId: s.external_id,
        externalVersion: s.external_version,
        sourceModifiedAt: s.source_modified_at.toISOString(),
        state: s.state,
        data: s.data,
      }),
    ),
    customers: customers.rows.map((c) => ({
      id: c.id,
      canonicalName: c.canonical_name,
      accountCode: c.account_code,
      lifecycleStatus: c.lifecycle_status,
    })),
    links: links.rows.map((l) => ({
      provider: l.provider,
      externalType: l.external_type,
      externalId: l.external_id,
      canonicalId: l.canonical_id,
    })),
    items: items.rows.map((i) => ({
      id: i.id,
      code: i.canonical_item_code,
      canonicalUnit: i.canonical_unit,
    })),
    snapshots: snapshots.rows.map((s) => ({
      externalId: s.external_id,
      itemCode: s.item_code,
      itemId: s.item_id,
      quantity: s.quantity,
      unit: s.unit,
      sourceVersion: s.source_version,
      observedAt: s.observed_at.toISOString(),
      location: s.location,
    })),
  });
  for (const link of exactLinks) await addLink(ctx, link, "exact-id-1");
  let opened = 0;
  for (const f of findings) {
    const { rows } = await ctx.db.query(
      `INSERT INTO app.reconciliation_findings (workspace_id, entity_type, entity_id, kind, severity,
         source_values, subject, dedupe_key, supersedes_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
         (SELECT id FROM app.reconciliation_findings
           WHERE workspace_id = $1 AND subject = $7 AND dedupe_key <> $8
           ORDER BY detected_at DESC, id DESC LIMIT 1))
       ON CONFLICT (workspace_id, dedupe_key) DO NOTHING RETURNING id`,
      [
        ctx.workspaceId,
        f.entityType,
        f.entityId,
        f.kind,
        f.severity,
        JSON.stringify(f.evidence),
        f.subject,
        f.dedupeKey,
      ],
    );
    opened += rows.length;
  }
  return { opened, skipped: false };
}

// For the customer view: how one organization looks from each source.
export async function customerSources(db: Db, workspaceId: string, id: string) {
  const customer = (
    await db.query(
      "SELECT id, canonical_name, account_code, lifecycle_status FROM app.customers WHERE workspace_id = $1 AND id = $2",
      [workspaceId, id],
    )
  ).rows[0] as Row | undefined;
  if (!customer) throw notFound();
  const { rows: links } = await db.query(
    `SELECT l.provider, l.external_type, l.external_id, l.last_seen, r.relationship_role, r.mapping_version,
            r.approved_by, s.data ->> 'name' AS source_name, s.state AS source_state,
            (SELECT count(*)::int FROM app.invoices i
              WHERE i.workspace_id = l.workspace_id AND i.bill_to_external_id = l.external_id) AS invoices
       FROM app.external_record_links l
       LEFT JOIN app.customer_source_relationships r
         ON r.workspace_id = l.workspace_id AND r.external_record_link_id = l.id
       LEFT JOIN app.source_records s
         ON s.workspace_id = l.workspace_id AND s.provider = l.provider
        AND s.external_type = l.external_type AND s.external_id = l.external_id
      WHERE l.workspace_id = $1 AND l.canonical_type = 'customer' AND l.canonical_id = $2
      ORDER BY l.provider, l.external_id LIMIT 50`,
    [workspaceId, id],
  );
  return {
    id: customer.id,
    name: customer.canonical_name,
    accountCode: customer.account_code,
    lifecycleStatus: customer.lifecycle_status,
    sources: links.map((l) => ({
      provider: l.provider,
      recordType: l.external_type,
      externalId: l.external_id,
      sourceName: l.source_name,
      sourceState: l.source_state ?? "not_synced",
      role: l.relationship_role,
      mappingVersion: l.mapping_version,
      approvedBy: l.approved_by,
      lastSeen: l.last_seen.toISOString(),
      invoices: l.invoices,
    })),
  };
}

export { isOpenState };
