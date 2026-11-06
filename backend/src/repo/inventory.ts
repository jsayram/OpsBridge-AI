import type { Db } from "../db";

type Row = Record<string, unknown>;

const TEMPLATE_ID = "(SELECT id FROM app.workspaces WHERE mode = 'template')";

// Newest source version per source record, with its item. Keyset on item code.
export async function listInventory(
  db: Db,
  q: { workspaceId: string; shared: boolean; limit: number; after?: string },
) {
  const owner = q.shared ? `coalesce(${TEMPLATE_ID}, $1::uuid)` : "$1::uuid";
  const { rows: items } = await db.query(
    `SELECT id, canonical_item_code, description, canonical_unit, lifecycle_status
       FROM app.inventory_items
      WHERE workspace_id = ${owner} AND ($2::text IS NULL OR canonical_item_code > $2)
      ORDER BY canonical_item_code LIMIT $3`,
    [q.workspaceId, q.after ?? null, q.limit + 1],
  );
  const page = items.slice(0, q.limit);
  const { rows: snapshots } = await db.query(
    `SELECT DISTINCT ON (s.external_id) s.item_id, s.external_id, s.item_code, trim_scale(s.quantity)::text AS quantity,
            s.unit, s.location, s.source_version, s.observed_at, s.ingested_at,
            (SELECT count(*)::int FROM app.inventory_snapshots o
              WHERE o.workspace_id = s.workspace_id AND o.provider = s.provider
                AND o.external_id = s.external_id) AS versions
       FROM app.inventory_snapshots s
      WHERE s.workspace_id = ${owner} AND (s.item_id = ANY($2::uuid[]) OR ($3 AND s.item_id IS NULL))
      ORDER BY s.external_id, s.source_version DESC LIMIT 200`,
    [q.workspaceId, page.map((i) => i.id), q.after === undefined],
  );
  const fact = (s: Row) => ({
    externalId: s.external_id,
    itemCode: s.item_code,
    quantity: s.quantity,
    unit: s.unit,
    location: s.location,
    sourceVersion: s.source_version,
    versions: s.versions,
    observedAt: (s.observed_at as Date).toISOString(),
    ingestedAt: (s.ingested_at as Date).toISOString(),
  });
  return {
    sourceLabel: "Simulated",
    items: page.map((i) => ({
      id: i.id,
      code: i.canonical_item_code,
      description: i.description,
      canonicalUnit: i.canonical_unit,
      lifecycleStatus: i.lifecycle_status,
      snapshots: snapshots.filter((s) => s.item_id === i.id).map(fact),
    })),
    unresolved: snapshots.filter((s) => s.item_id === null).map(fact),
    ...(items.length > q.limit ? { nextCursor: page.at(-1)?.canonical_item_code } : {}),
  };
}
