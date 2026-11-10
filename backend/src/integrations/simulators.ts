import snapshot from "../../../sample-data/simulator-snapshot.json";
import { type Scenario, TRANSPORT_FAULTS } from "./scenarios";
import { AdapterError, type Transport } from "./types";

// Three simulated sources that answer Request with Response, so adapters and their error
// handling run exactly as they would over HTTP.
//
// The ERP Simulator follows SuiteTalk REST conventions from Oracle's public help pages: the
// /services/rest/record/v1 collection shape with links, count, offset, hasMore and totalResults;
// ID stubs in collections; offset divisible by limit; POST query/v1/suiteql with Prefer: transient
// and a { q } body; the o:errorDetails error body. It is a simulator of a convention, built from
// original data. It is not NetSuite, not certified, and has never been compared with a real
// account (docs/design/INTEGRATION-CONTRACTS.md).

const SIM_HOST = "https://simulator.invalid";
export const SIMULATOR_ORIGIN = SIM_HOST;

export type SimulatorOptions = {
  scenario: Scenario;
  // Operator resume clears a fault, which is what "the source recovered" looks like here.
  faultsActive: boolean;
  shiftMs: number;
};

const shift = (iso: string, ms: number) =>
  new Date(Date.parse(iso) + ms).toISOString().replace(".000Z", "Z");

type Row = Record<string, unknown>;

function faultGate(options: SimulatorOptions) {
  const fault = options.faultsActive ? TRANSPORT_FAULTS[options.scenario] : undefined;
  let left = fault?.times ?? 0;
  // Called for each page request. Returns the failure to serve, if any.
  return (laterPage: boolean, render: (status: number, retryAfter?: number) => Response) => {
    if (!fault || !laterPage || left <= 0) return null;
    left--;
    if (fault.kind === "timeout") throw new AdapterError("transient", "timeout");
    if (fault.kind === "malformed") {
      return new Response("<html>not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return render(fault.status as number, fault.retryAfter);
  };
}

// --- ERP ---------------------------------------------------------------------------------

const ERP_ERRORS: Record<number, [string, string, string]> = {
  400: ["Bad Request", "INVALID_PARAMETER", "Invalid request parameter."],
  401: ["Unauthorized", "INVALID_LOGIN", "Invalid login attempt."],
  403: ["Forbidden", "INSUFFICIENT_PERMISSION", "Permission violation."],
  404: ["Not Found", "NONEXISTENT_ID", "Record does not exist."],
  429: ["Too Many Requests", "CONCURRENCY_LIMIT_EXCEEDED", "Concurrent request limit exceeded."],
  500: ["Internal Server Error", "UNEXPECTED_ERROR", "An unexpected error occurred."],
};

const erpError = (status: number, retryAfter?: number) => {
  const [title, code, detail] = ERP_ERRORS[status] ?? (ERP_ERRORS[500] as [string, string, string]);
  return new Response(
    JSON.stringify({
      type: "https://www.rfc-editor.org/rfc/rfc9110.html",
      title,
      status,
      "o:errorDetails": [{ detail, "o:errorCode": code }],
    }),
    {
      status,
      headers: {
        "content-type": "application/vnd.oracle.resource+json; type=error",
        ...(retryAfter !== undefined ? { "retry-after": String(retryAfter) } : {}),
      },
    },
  );
};

const erpJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/vnd.oracle.resource+json; type=collection" },
  });

function erpData(options: SimulatorOptions) {
  const { scenario, shiftMs } = options;
  const customers: Row[] = snapshot.erp.customers.map((c) => ({
    ...c,
    lastmodifieddate: shift(c.lastmodifieddate, shiftMs),
  }));
  const t = snapshot.erp.invoiceTemplate;
  const invoices: Row[] = Array.from({ length: t.count }, (_, i) => {
    const day = new Date(Date.parse(t.startDay) + i * 86_400_000).toISOString().slice(0, 10);
    return {
      id: String(90001 + i),
      tranid: `INV-${String(4001 + i)}`,
      entity: t.customers[i % t.customers.length],
      foreigntotal: (t.firstAmount + i * t.amountStep).toFixed(2),
      currency: t.currency,
      trandate: day,
      status: ["A", "C", "B"][i % 3],
      lastmodifieddate: shift(`${day}T17:00:00Z`, shiftMs),
    };
  });
  const later = (iso: unknown, minutes: number) =>
    new Date(Date.parse(iso as string) + minutes * 60_000).toISOString().replace(".000Z", "Z");
  const cedar = customers.findIndex((c) => c.id === "6001");
  const edit = (change: Row) => {
    const row = customers[cedar] as Row;
    customers[cedar] = { ...row, ...change, lastmodifieddate: later(row.lastmodifieddate, 600) };
  };
  switch (scenario) {
    case "renamed_customer":
      edit({ companyname: "Cedar Point Outdoor Services, Inc. (fictional)" });
      break;
    case "mismatched_account":
      edit({ accountnumber: "NS-2002" });
      break;
    case "deleted_record":
      customers.splice(cedar, 1);
      break;
    case "stale_version": {
      // An old read arrives late: an older timestamp carrying a name that must not win.
      const row = customers[cedar] as Row;
      customers[cedar] = {
        ...row,
        companyname: "Cedar Point Landscaping OLD (fictional)",
        lastmodifieddate: later(row.lastmodifieddate, -10_000),
      };
      break;
    }
    case "duplicate_event":
      customers.splice(1, 0, { ...(customers[0] as Row) }, { ...(customers[0] as Row) });
      invoices.push({ ...(invoices[0] as Row) });
      break;
    case "out_of_order": {
      // The newer record is read first, then an older copy of it.
      const row = customers[cedar] as Row;
      const newer = {
        ...row,
        companyname: "Cedar Point Landscaping, Incorporated (fictional)",
        lastmodifieddate: later(row.lastmodifieddate, 600),
      };
      customers.splice(cedar, 1);
      customers.unshift(newer);
      customers.push({ ...row });
      break;
    }
    case "unknown_field":
      customers[0] = { ...(customers[0] as Row), custentity_unmapped_note: "dropped and counted" };
      break;
    case "privileged_field":
      customers[0] = { ...(customers[0] as Row), workspace_id: "not-a-real-workspace" };
      break;
    default:
  }
  return { customers, invoices };
}

// A paged response in the documented collection shape.
function collection(base: string, rows: Row[], limit: number, offset: number, query = "") {
  const page = rows.slice(offset, offset + limit);
  const href = (at: number) => `${base}?limit=${limit}&offset=${at}${query}`;
  const hasMore = offset + limit < rows.length;
  return {
    links: [
      { rel: "self", href: href(offset) },
      ...(offset > 0 ? [{ rel: "prev", href: href(offset - limit) }] : []),
      ...(hasMore ? [{ rel: "next", href: href(offset + limit) }] : []),
    ],
    count: page.length,
    hasMore,
    items: page,
    offset,
    totalResults: rows.length,
  };
}

const CUSTOMER_Q =
  /^SELECT .+ FROM customer( WHERE lastmodifieddate >= \?)? ORDER BY lastmodifieddate, id$/i;
const INVOICE_Q =
  /^SELECT .+ FROM transaction WHERE type = 'CustInvc'( AND lastmodifieddate >= \?)? ORDER BY lastmodifieddate, id$/i;

export function erpSimulator(options: SimulatorOptions): Transport {
  const data = erpData(options);
  const gate = faultGate(options);
  const paging = (url: URL) => {
    const limit = Number(url.searchParams.get("limit") ?? 1000);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const ok =
      Number.isInteger(limit) &&
      limit >= 1 &&
      limit <= 1000 &&
      Number.isInteger(offset) &&
      offset >= 0 &&
      offset % limit === 0;
    return ok ? { limit, offset } : null;
  };
  return async (req) => {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/services/rest/query/v1/suiteql" && req.method === "POST") {
      if (req.headers.get("prefer") !== "transient") return erpError(400);
      const page = paging(url);
      const body = (await req.json().catch(() => null)) as { q?: unknown; params?: unknown } | null;
      if (!page || typeof body?.q !== "string") return erpError(400);
      const failed = gate(page.offset > 0 || options.scenario === "http_429_long", erpError);
      if (failed) return failed;
      const isCustomer = CUSTOMER_Q.test(body.q);
      if (!isCustomer && !INVOICE_Q.test(body.q)) return erpError(400);
      const since = Array.isArray(body.params) ? (body.params[0] as string | undefined) : undefined;
      const source = isCustomer ? data.customers : data.invoices;
      const rows = since ? source.filter((r) => (r.lastmodifieddate as string) >= since) : source;
      return erpJson(collection(`${SIM_HOST}${url.pathname}`, rows, page.limit, page.offset));
    }
    if (parts.slice(0, 4).join("/") === "services/rest/record/v1" && req.method === "GET") {
      const [, , , , type, id] = parts;
      const rows = type === "customer" ? data.customers : type === "invoice" ? data.invoices : null;
      if (!rows) return erpError(404);
      const self = (rowId: unknown) => ({
        rel: "self",
        href: `${SIM_HOST}/services/rest/record/v1/${type}/${rowId}`,
      });
      if (id) {
        const row = id.startsWith("eid:")
          ? rows.find((r) => r.externalid === id.slice(4))
          : rows.find((r) => r.id === id);
        if (!row) return erpError(404);
        return erpJson({ links: [self(row.id)], ...row });
      }
      const page = paging(url);
      if (!page) return erpError(400);
      const stubs = rows.map((r) => ({ links: [self(r.id)], id: r.id }));
      return erpJson(
        collection(`${SIM_HOST}/services/rest/record/v1/${type}`, stubs, page.limit, page.offset),
      );
    }
    return erpError(404);
  };
}

// --- CRM ---------------------------------------------------------------------------------
// Salesforce REST shape: SOQL query with totalSize, done, nextRecordsUrl, records[].attributes,
// and errors as an array. The live connector runs the same mapper against the same shape.

const crmError = (status: number, retryAfter?: number) => {
  const code =
    status === 401
      ? "INVALID_SESSION_ID"
      : status === 403
        ? "INSUFFICIENT_ACCESS"
        : status === 429
          ? "REQUEST_LIMIT_EXCEEDED"
          : "UNKNOWN_EXCEPTION";
  return new Response(JSON.stringify([{ message: "Simulated CRM error", errorCode: code }]), {
    status,
    headers: {
      "content-type": "application/json",
      ...(retryAfter !== undefined ? { "retry-after": String(retryAfter) } : {}),
    },
  });
};

export const CRM_API_VERSION = "v62.0";

export function crmSimulator(options: SimulatorOptions): Transport {
  const records: Row[] = snapshot.crm.organizations.map((o) => ({
    attributes: {
      type: "Account",
      url: `/services/data/${CRM_API_VERSION}/sobjects/Account/${o.Id}`,
    },
    ...o,
    LastModifiedDate: shift(o.LastModifiedDate, options.shiftMs),
  }));
  if (options.scenario === "unknown_field") {
    records[0] = { ...(records[0] as Row), Unmapped_Note__c: "dropped and counted" };
  }
  const gate = faultGate(options);
  const pageOf = (offset: number, batch: number, since?: string) => {
    const rows = since ? records.filter((r) => (r.LastModifiedDate as string) >= since) : records;
    const next = offset + batch;
    const done = next >= rows.length;
    return new Response(
      JSON.stringify({
        totalSize: rows.length,
        done,
        ...(done
          ? {}
          : {
              nextRecordsUrl: `/services/data/${CRM_API_VERSION}/query/SIM-${next}-${batch}${since ? `-${encodeURIComponent(since)}` : ""}`,
            }),
        records: rows.slice(offset, next),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return async (req) => {
    const url = new URL(req.url);
    if (req.method !== "GET") return crmError(400);
    const more = url.pathname.match(
      new RegExp(`^/services/data/${CRM_API_VERSION}/query/SIM-(\\d+)-(\\d+)(?:-(.+))?$`),
    );
    if (more) {
      const failed = gate(true, crmError);
      if (failed) return failed;
      return pageOf(
        Number(more[1]),
        Number(more[2]),
        more[3] ? decodeURIComponent(more[3]) : undefined,
      );
    }
    if (url.pathname === `/services/data/${CRM_API_VERSION}/query`) {
      const failed = gate(options.scenario === "http_429_long", crmError);
      if (failed) return failed;
      const q = url.searchParams.get("q") ?? "";
      if (!/^SELECT .+ FROM Account/i.test(q)) return crmError(400);
      const since = q.match(/LastModifiedDate >= (\S+)/)?.[1];
      const batch = Number(
        req.headers.get("sforce-query-options")?.match(/batchSize=(\d+)/)?.[1] ?? 2000,
      );
      return pageOf(0, batch, since);
    }
    return crmError(400);
  };
}

// --- Inventory ---------------------------------------------------------------------------

const inventoryError = (status: number, retryAfter?: number) =>
  new Response(JSON.stringify({ error: `simulated_${status}` }), {
    status,
    headers: {
      "content-type": "application/json",
      ...(retryAfter !== undefined ? { "retry-after": String(retryAfter) } : {}),
    },
  });

export function inventorySimulator(options: SimulatorOptions): Transport {
  const rows: Row[] = snapshot.inventory.snapshots.map((s) => ({
    ...s,
    sourceTimestamp: shift(s.sourceTimestamp, options.shiftMs),
  }));
  const first = rows[0] as Row;
  const second = rows[1] as Row;
  if (options.scenario === "duplicate_event") rows.splice(1, 0, { ...first }, { ...first });
  if (options.scenario === "stale_version") {
    // Version 3 of INV-203 is already the source's latest. This older copy must change nothing.
    rows.push({ ...(rows[3] as Row), version: 2, quantity: "99" });
  }
  if (options.scenario === "out_of_order") {
    rows.unshift({ ...second, version: 2, quantity: "15" });
  }
  const gate = faultGate(options);
  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/stock-snapshots" || req.method !== "GET") return inventoryError(404);
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1) {
      return inventoryError(400);
    }
    const failed = gate(after > 0 || options.scenario === "http_429_long", inventoryError);
    if (failed) return failed;
    const next = after + limit;
    return new Response(
      JSON.stringify({
        items: rows.slice(after, next),
        ...(next < rows.length ? { nextAfter: next } : {}),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}
