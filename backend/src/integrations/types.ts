import type { Stream } from "./mappers";

export type SourceSystem = "crm" | "erp" | "inventory";
export type Provider =
  | "crm_simulator"
  | "erp_simulator"
  | "inventory_simulator"
  | "salesforce_test";
export type ConnectionMode = "simulated" | "connected_test";

export type SourceRecord<T = unknown> = {
  stream: Stream;
  externalId: string;
  externalVersion: string;
  sourceModifiedAt: string;
  observedAt: string;
  data: T;
};

export type PageStats = {
  unknownFields: number;
  rejected: { externalId: string; reason: string }[];
};
export type Page = {
  items: SourceRecord[];
  stats: PageStats;
  // Absent on the last page. Opaque to everything but the adapter that wrote it.
  nextCursor?: string;
  highWatermark: string | null;
};
export type ListInput = { cursor?: string; limit: number; since?: string };

export interface SourceAdapter {
  readonly system: SourceSystem;
  readonly provider: Provider;
  readonly mode: ConnectionMode;
  readonly pageSize: number;
  list(input: ListInput): Promise<Page>;
  health(): Promise<{ status: "ok" | "degraded"; detail: string }>;
}

// How a failure behaves. Retry policy, run state and the operator message all read from this one
// table, so a new provider error only has to be classified once.
export type FailureClass =
  | "transient"
  | "rate_limited"
  | "auth"
  | "permission"
  | "invalid_payload"
  | "cursor";

export const FAILURE_POLICY: Record<
  FailureClass,
  { retry: boolean; run: "failed" | "dead_letter"; message: string }
> = {
  transient: {
    retry: true,
    run: "failed",
    message: "The source stopped answering. Progress is saved, so retry when it recovers.",
  },
  rate_limited: {
    retry: true,
    run: "failed",
    message: "The source kept asking us to slow down. Progress is saved, so retry shortly.",
  },
  auth: {
    retry: false,
    run: "dead_letter",
    message: "The source rejected our credentials. Fix the connection, then retry.",
  },
  permission: {
    retry: false,
    run: "dead_letter",
    message: "The source refused this read. Check the integration role, then retry.",
  },
  invalid_payload: {
    retry: false,
    run: "dead_letter",
    message: "The source sent data we can't read. Nothing from that page was kept.",
  },
  cursor: {
    retry: false,
    run: "dead_letter",
    message: "The saved position is no longer valid. Start a full sync.",
  },
};

export class AdapterError extends Error {
  constructor(
    readonly failure: FailureClass,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    // The message is the code alone. Provider text never travels with the error.
    super(code);
    this.name = "AdapterError";
  }
}

export type Transport = (request: Request) => Promise<Response>;
