import type { Provider } from "./types";

// Every PRD 8.4 fault plus the P3 build-task faults, as a closed list. A guest picks a name from
// this list; nothing about a fault comes from the request. Each one is a simulator behavior and
// can't reach a live adapter.
export const SCENARIOS = {
  baseline: { label: "Normal sync", providers: "all" },
  http_401: { label: "Credentials revoked (401)", providers: "all" },
  http_403: { label: "Role lost access (403)", providers: "all" },
  http_429: { label: "Rate limited, then fine (429)", providers: "all" },
  http_429_long: { label: "Rate limited for too long (429)", providers: "all" },
  http_5xx_transient: { label: "Brief outage (500, then fine)", providers: "all" },
  http_5xx_outage: { label: "Outage (500 until resumed)", providers: "all" },
  timeout: { label: "Source stops answering (timeout)", providers: "all" },
  malformed_payload: { label: "Malformed page", providers: "all" },
  duplicate_event: {
    label: "Duplicate records in the feed",
    providers: ["erp_simulator", "inventory_simulator"],
  },
  out_of_order: {
    label: "Records out of order",
    providers: ["erp_simulator", "inventory_simulator"],
  },
  renamed_customer: { label: "Customer renamed", providers: ["erp_simulator"] },
  stale_version: {
    label: "Stale version delivered",
    providers: ["erp_simulator", "inventory_simulator"],
  },
  deleted_record: { label: "Mapped record deleted", providers: ["erp_simulator"] },
  mismatched_account: { label: "Account ID mismatch", providers: ["erp_simulator"] },
  unknown_field: {
    label: "Unknown field in the feed",
    providers: ["erp_simulator", "crm_simulator"],
  },
  privileged_field: { label: "Privileged field in the feed", providers: ["erp_simulator"] },
} as const satisfies Record<string, { label: string; providers: "all" | readonly Provider[] }>;

export type Scenario = keyof typeof SCENARIOS;
export const SCENARIO_NAMES = Object.keys(SCENARIOS) as Scenario[];

export const scenarioApplies = (scenario: Scenario, provider: Provider) => {
  const { providers } = SCENARIOS[scenario];
  return providers === "all" || (providers as readonly Provider[]).includes(provider);
};
export const isScenario = (value: unknown): value is Scenario =>
  typeof value === "string" && Object.hasOwn(SCENARIOS, value);

type TransportFault = {
  status?: number;
  retryAfter?: number;
  times: number;
  kind: "http" | "timeout" | "malformed";
};

// A fault fires on the second page, so the first page's commit shows what survives a failure.
export const TRANSPORT_FAULTS: Partial<Record<Scenario, TransportFault>> = {
  http_401: { kind: "http", status: 401, times: Number.POSITIVE_INFINITY },
  http_403: { kind: "http", status: 403, times: Number.POSITIVE_INFINITY },
  http_429: { kind: "http", status: 429, retryAfter: 0, times: 2 },
  http_429_long: { kind: "http", status: 429, retryAfter: 120, times: Number.POSITIVE_INFINITY },
  http_5xx_transient: { kind: "http", status: 500, times: 2 },
  http_5xx_outage: { kind: "http", status: 500, times: Number.POSITIVE_INFINITY },
  timeout: { kind: "timeout", times: Number.POSITIVE_INFINITY },
  malformed_payload: { kind: "malformed", times: Number.POSITIVE_INFINITY },
};
