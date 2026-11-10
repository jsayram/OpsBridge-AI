import { callWithPolicy, DEFAULT_POLICY, type RetryPolicy, readJson } from "./http";
import {
  type MapResult,
  mapCrmOrganization,
  mapErpCustomer,
  mapErpInvoice,
  mapInventoryFact,
  type Stream,
} from "./mappers";
import type { Scenario } from "./scenarios";
import {
  CRM_API_VERSION,
  crmSimulator,
  erpSimulator,
  inventorySimulator,
  SIMULATOR_ORIGIN,
} from "./simulators";
import {
  AdapterError,
  type ListInput,
  type Page,
  type Provider,
  type SourceAdapter,
  type SourceRecord,
  type Transport,
} from "./types";

function collect<T>(
  stream: Stream,
  rows: unknown[],
  map: (raw: unknown) => MapResult<T>,
  observedAt: string,
) {
  const items: SourceRecord[] = [];
  const rejected: { externalId: string; reason: string }[] = [];
  let unknownFields = 0;
  let highWatermark: string | null = null;
  for (const raw of rows) {
    const out = map(raw);
    if (!out.ok) {
      rejected.push(out.rejected);
      continue;
    }
    const v = out.value;
    unknownFields += v.unknownFields;
    if (!highWatermark || v.sourceModifiedAt > highWatermark) highWatermark = v.sourceModifiedAt;
    items.push({
      stream,
      externalId: v.externalId,
      externalVersion: v.externalVersion,
      sourceModifiedAt: v.sourceModifiedAt,
      observedAt,
      data: v.data,
    });
  }
  return { items, stats: { unknownFields, rejected }, highWatermark };
}

const asObject = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdapterError("invalid_payload", "unexpected_shape");
  }
  return value as Record<string, unknown>;
};
const asArray = (value: unknown) => {
  if (!Array.isArray(value)) throw new AdapterError("invalid_payload", "unexpected_shape");
  return value as unknown[];
};

// --- ERP, over SuiteQL ---------------------------------------------------------------------
// A collection GET returns only ID stubs, so one record per request would mean one call per row.
// One SuiteQL page reads the fields in a single call, ordered so paging is stable.

const ERP_STREAMS = {
  customer: {
    map: mapErpCustomer,
    query: (delta: boolean) =>
      `SELECT id, entityid, companyname, isperson, stage, subsidiary, parent, accountnumber, externalid, custentity_ob_crm_account_id, lastmodifieddate, isinactive FROM customer${delta ? " WHERE lastmodifieddate >= ?" : ""} ORDER BY lastmodifieddate, id`,
  },
  invoice: {
    map: mapErpInvoice,
    query: (delta: boolean) =>
      `SELECT id, tranid, entity, foreigntotal, currency, trandate, status, lastmodifieddate FROM transaction WHERE type = 'CustInvc'${delta ? " AND lastmodifieddate >= ?" : ""} ORDER BY lastmodifieddate, id`,
  },
} as const;
const ERP_ORDER = ["customer", "invoice"] as const;
type ErpStream = (typeof ERP_ORDER)[number];

const parseErpCursor = (cursor: string | undefined): { stream: ErpStream; offset: number } => {
  if (cursor === undefined) return { stream: "customer", offset: 0 };
  const m = cursor.match(/^erp1:(customer|invoice):(\d{1,7})$/);
  if (!m) throw new AdapterError("cursor", "cursor_unreadable");
  return { stream: m[1] as ErpStream, offset: Number(m[2]) };
};

export function erpAdapter(
  transport: Transport,
  provider: Provider = "erp_simulator",
  policy: RetryPolicy = DEFAULT_POLICY,
  base = SIMULATOR_ORIGIN,
): SourceAdapter {
  const list = async ({ cursor, limit, since }: ListInput): Promise<Page> => {
    const { stream, offset } = parseErpCursor(cursor);
    const spec = ERP_STREAMS[stream];
    const res = await callWithPolicy(
      transport,
      () =>
        new Request(`${base}/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`, {
          method: "POST",
          headers: { prefer: "transient", "content-type": "application/json" },
          body: JSON.stringify({
            q: spec.query(since !== undefined),
            ...(since !== undefined ? { params: [since] } : {}),
          }),
        }),
      policy,
    );
    const body = asObject(await readJson(res));
    const rows = asArray(body.items);
    const observedAt = new Date().toISOString();
    const out =
      stream === "customer"
        ? collect("customer", rows, spec.map as typeof mapErpCustomer, observedAt)
        : collect("invoice", rows, spec.map as typeof mapErpInvoice, observedAt);
    const hasMore = body.hasMore === true;
    const next = ERP_ORDER[ERP_ORDER.indexOf(stream) + 1];
    return {
      ...out,
      ...(hasMore
        ? { nextCursor: `erp1:${stream}:${offset + limit}` }
        : next
          ? { nextCursor: `erp1:${next}:0` }
          : {}),
    };
  };
  return {
    system: "erp",
    provider,
    mode: "simulated",
    pageSize: 4,
    list,
    health: async () => {
      await callWithPolicy(
        transport,
        () => new Request(`${base}/services/rest/record/v1/customer?limit=1`),
        policy,
      );
      return { status: "ok", detail: "reachable" };
    },
  };
}

// --- CRM, in Salesforce REST shape ---------------------------------------------------------
// Shared by the simulator and the owner-only live connector, so the double exercises the code
// that a real org would.

export const crmSoql = (since?: string) =>
  `SELECT Id, Name, Type, AccountNumber, LastModifiedDate FROM Account${since ? ` WHERE LastModifiedDate >= ${since}` : ""} ORDER BY LastModifiedDate, Id`;

const CRM_NEXT = new RegExp(
  `^/services/data/${CRM_API_VERSION.replace(".", "\\.")}/query/[\\w.%-]{1,200}$`,
);

export function crmAdapter(
  transport: Transport,
  options: {
    provider: Provider;
    mode: "simulated" | "connected_test";
    base: string;
    pageSize: number;
    headers?: () => Record<string, string>;
    policy?: RetryPolicy;
  },
): SourceAdapter {
  const policy = options.policy ?? DEFAULT_POLICY;
  const headers = () => options.headers?.() ?? {};
  return {
    system: "crm",
    provider: options.provider,
    mode: options.mode,
    pageSize: options.pageSize,
    async list({ cursor, limit, since }) {
      // A stored cursor is only ever a path on the configured host, so it can't redirect a token.
      if (cursor !== undefined && !CRM_NEXT.test(cursor)) {
        throw new AdapterError("cursor", "cursor_unreadable");
      }
      const url =
        cursor !== undefined
          ? `${options.base}${cursor}`
          : `${options.base}/services/data/${CRM_API_VERSION}/query?q=${encodeURIComponent(crmSoql(since))}`;
      const res = await callWithPolicy(
        transport,
        () =>
          new Request(url, {
            headers: { ...headers(), "sforce-query-options": `batchSize=${limit}` },
          }),
        policy,
      );
      const body = asObject(await readJson(res));
      const out = collect(
        "organization",
        asArray(body.records),
        mapCrmOrganization,
        new Date().toISOString(),
      );
      const next = body.nextRecordsUrl;
      if (body.done === false && typeof next !== "string") {
        throw new AdapterError("invalid_payload", "unexpected_shape");
      }
      return { ...out, ...(body.done === false ? { nextCursor: next as string } : {}) };
    },
    async health() {
      await callWithPolicy(
        transport,
        () =>
          new Request(`${options.base}/services/data/${CRM_API_VERSION}/limits`, {
            headers: headers(),
          }),
        policy,
      );
      return { status: "ok", detail: "reachable" };
    },
  };
}

// --- Inventory -----------------------------------------------------------------------------

export function inventoryAdapter(
  transport: Transport,
  policy: RetryPolicy = DEFAULT_POLICY,
): SourceAdapter {
  return {
    system: "inventory",
    provider: "inventory_simulator",
    mode: "simulated",
    pageSize: 3,
    async list({ cursor, limit }) {
      if (cursor !== undefined && !/^\d{1,7}$/.test(cursor)) {
        throw new AdapterError("cursor", "cursor_unreadable");
      }
      const res = await callWithPolicy(
        transport,
        () =>
          new Request(`${SIMULATOR_ORIGIN}/v1/stock-snapshots?limit=${limit}&after=${cursor ?? 0}`),
        policy,
      );
      const body = asObject(await readJson(res));
      const out = collect(
        "inventory_snapshot",
        asArray(body.items),
        mapInventoryFact,
        new Date().toISOString(),
      );
      return {
        ...out,
        ...(typeof body.nextAfter === "number" ? { nextCursor: String(body.nextAfter) } : {}),
      };
    },
    health: async () => ({ status: "ok", detail: "reachable" }),
  };
}

// The only constructor for simulated sources. Live adapters are built elsewhere, on a path that
// requires a verified owner.
export function simulatedAdapter(
  provider: Exclude<Provider, "salesforce_test">,
  options: { scenario: Scenario; faultsActive: boolean; shiftMs: number; policy?: RetryPolicy },
): SourceAdapter {
  const sim = {
    scenario: options.scenario,
    faultsActive: options.faultsActive,
    shiftMs: options.shiftMs,
  };
  const policy = options.policy ?? DEFAULT_POLICY;
  switch (provider) {
    case "crm_simulator":
      return crmAdapter(crmSimulator(sim), {
        provider,
        mode: "simulated",
        base: SIMULATOR_ORIGIN,
        pageSize: 2,
        policy,
      });
    case "erp_simulator":
      return erpAdapter(erpSimulator(sim), provider, policy);
    case "inventory_simulator":
      return inventoryAdapter(inventorySimulator(sim), policy);
  }
}
