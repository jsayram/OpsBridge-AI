# Integration contracts

Every source and sink sits behind a typed adapter. The public demo uses the simulated adapter of each. Labels follow PRD 4.3.

## Source adapter (CRM, ERP, inventory)

Implemented at P3 in `backend/src/integrations/`. The types below are the code's.

```ts
interface SourceAdapter {
  readonly system: "crm" | "erp" | "inventory";
  readonly provider: "crm_simulator" | "erp_simulator" | "inventory_simulator" | "salesforce_test";
  readonly mode: "simulated" | "connected_test";
  readonly pageSize: number;
  list(input: { cursor?: string; limit: number; since?: string }): Promise<Page>;
  health(): Promise<{ status: "ok" | "degraded"; detail: string }>;
}
type SourceRecord<T> = {
  stream: "organization" | "customer" | "invoice" | "inventory_snapshot";
  externalId: string;
  externalVersion: string;
  sourceModifiedAt: string;
  observedAt: string;
  data: T;
};
type Page = {
  items: SourceRecord[];
  stats: { unknownFields: number; rejected: { externalId: string; reason: string }[] };
  nextCursor?: string;
  highWatermark: string | null;
};
```

| Rule | Applies to | Where |
|---|---|---|
| Timeout 8 s, retries 3 with jittered backoff, 429 honors `Retry-After` | All | `http.ts` |
| A `Retry-After` over 10 s isn't slept through; the run fails, keeps its cursor and an operator resumes | All | `http.ts` |
| 401, 403 and validation errors don't retry | All | `FAILURE_POLICY` in `types.ts` |
| A page and the cursor after it commit in one transaction; the connection's own cursor moves only when the run succeeds | All | `stepRun` in `repo/sync.ts` |
| No transaction stays open across a network call | All | `stepRun` |
| Unknown fields are dropped and counted, never stored raw | All | `mappers.ts` |
| A field that looks like authority (`workspace_id`, `role`, `token` and so on) rejects that record | All | `mappers.ts` |
| Fault modes: every PRD 8.4 fault, plus malformed payload, unknown field, privileged field and a long 429 | Simulators | `scenarios.ts`, closed list |
| OAuth with PKCE, owner-started, refresh token server-side and encrypted | Salesforce adapter | `salesforce.ts` |
| Item code, quantity, unit, location, external version, source timestamp; read-only | Inventory simulator | `simulators.ts` |

Which adapter runs comes from the connection row, which comes from the workspace, and never from the request. `simulatedAdapter` is the only constructor on the guest path, and it can't build a live adapter.

## Failure classes

| Class | Examples | Retried | Run ends as | Operator |
|---|---|---|---|---|
| `transient` | 5xx, 408, timeout, network | Yes, 3 times | `failed` | Resume from the saved cursor |
| `rate_limited` | 429 | Yes, honoring `Retry-After` up to 10 s | `failed` | Resume shortly |
| `auth` | 401, revoked token | No | `dead_letter` | Fix credentials, resume |
| `permission` | 403 | No | `dead_letter` | Fix the role, resume |
| `invalid_payload` | Malformed JSON, wrong shape, other 4xx | No | `dead_letter` | Fix the source, resume |
| `cursor` | Saved position unreadable | No | `dead_letter` | Start a full sync |

A resume is bounded at 5 per run. Errors carry a class and a code; provider text never reaches a run, a log, an audit row or a response.

## ERP Simulator and SuiteTalk REST conventions

The job posting names NetSuite as a strong plus, so the simulator follows Oracle's public help pages closely. This is a simulator of documented conventions built on original data. It is not NetSuite and has never been compared with a real account, and JOB-03 keeps real NetSuite as an experience gap.

| Convention | Simulator | Source |
|---|---|---|
| Base paths | `/services/rest/record/v1/...`, `/services/rest/query/v1/suiteql` | Oracle NetSuite help, REST web services |
| Collection shape | `links` (self, next, prev), `count`, `hasMore`, `items`, `offset`, `totalResults` | "Collection Paging" |
| Collections return stubs | `items` hold `links` and `id` only | "Collection Paging", use case for listing customers |
| Paging rule | `limit` and `offset`, and offset must be divisible by limit, or 400 | "Collection Paging" |
| Bulk read | `POST .../suiteql?limit&offset` with `Prefer: transient` and `{ q, params }`, one page of rows | "Executing SuiteQL Queries Through REST Web Services" |
| Single record | `/customer/{id}` and `/customer/eid:{externalId}` | REST record API |
| Errors | `type`, `title`, `status`, `o:errorDetails[].detail` and `o:errorCode`: `INVALID_LOGIN`, `NONEXISTENT_ID`, `CONCURRENCY_LIMIT_EXCEEDED`, `UNEXPECTED_ERROR` | "Error Handling in REST Web Services" |
| Customer record | One record type holds leads, prospects and customers, told apart by `stage`; `parent` for sub-customers; custom fields use the `custentity_` prefix | "Understanding Leads, Prospects, and Customers", "Customer Statuses" |

Why SuiteQL for the sync: a record collection only gives IDs, so reading fields that way costs one request per row against a concurrency-limited account. One SuiteQL page reads everything for that page in a single call, ordered by `lastmodifieddate, id` so paging stays stable. Oracle's concurrency sample shows no `Retry-After`, so a 429 without one falls back to backoff. A unit test covers that.

Known gaps from the real thing, on purpose: no TBA or OAuth 2.0 machine-to-machine handshake, only a small allowlist of query shapes, no real date-literal handling in `q`, and ISO timestamps where a real account returns its configured date format. An owner-authorized sandbox would be the place to close them.

## Salesforce test connection

Built from Salesforce's public OAuth and REST documentation, and tested only against the labeled double in `tests/integration/salesforce-double.ts`. **P3-D stays Pending Owner Credentials.** `docs/runbooks/CONNECTORS.md` has setup and revocation.

Salesforce has no read-only OAuth scope. The connector requests `api refresh_token`, and read-only holds in two other places: the adapter refuses any non-GET to the data API, and the runbook has the owner connect an integration user with read-only permissions. A token goes only to an https host under `salesforce.com`, whatever a token response claims, a stored page cursor can only be a path on that host, and redirects are errors rather than followed. An expired access token gets one refresh, outside the retrying transport, so a retry can't spend one refresh token twice. Disconnect ends any running run, and a late refresh can't restore a scrubbed token.

## Sink adapter

```ts
interface EventSink {
  readonly mode: "simulated" | "sheet_bridge" | "webhook";
  deliver(event: EventEnvelope, signal: AbortSignal): Promise<DeliveryResult>;
}
type DeliveryResult =
  | { kind: "accepted"; evidenceRef: string }
  | { kind: "retryable"; code: string; retryAfterSeconds?: number }
  | { kind: "permanent"; code: string };
```

Demo workspaces are bound to `simulated` before the adapter is chosen, based on the workspace mode from the database and not on a flag from the request.

## Mode A: Google Sheet bridge

The Sheets API offers no idempotency key on `values.append`, so an event ID column does the work.

**Credential.** One Google service account with the `spreadsheets` scope, shared as editor on one sheet. Its key is a Worker secret named `GOOGLE_SA_KEY`. The Worker signs an RS256 JWT with WebCrypto and exchanges it for a one-hour token, held in memory for that isolate only. Local signing measured about 1 ms of CPU. Zapier has its own separate Google connection, held in Jose's Zapier account.

**Sheet.** Tab `Events`, columns `event_id`, `event_type`, `occurred_at`, `case_ref`, `summary`, `mode`. Mode is always `TEST`. Row 1 is the header.

**Sequence.** Dispatcher holds a 130-second lease for the event.

1. `values.get` on `Events!A2:A` with a 10-second timeout.
2. If the event ID is present, go to step 4 and skip the append.
3. `values.append` of one row, `insertDataOption=INSERT_ROWS`, 10-second timeout.
4. `finish_outbox` to Accepted, evidence Provider Accepted, `evidence_ref` set to the row range or `found-by-check`.

**Failure handling.**

| Failure | Result |
|---|---|
| Timeout or 5xx on either call | Retry Scheduled, no sooner than 120 s |
| 429 | Retry Scheduled, honoring `Retry-After` |
| 401 | One token refresh, then Retry Scheduled |
| 403 or 404 | Dead Letter: the sheet share is broken and retrying won't fix it |
| Worker dies mid-attempt | Lease expires; next tick reclaims, up to 6 attempts, then Dead Letter; check finds any row already written |

**Why two dispatchers can't race.** Only the lease holder works on an event. Both calls together take at most 20 s, so they end well inside the 130-second lease, and `claim_due_outbox` uses `SKIP LOCKED`. The lease is longer than the 120-second retry floor so a Worker that dies mid-append waits at least as long as a timed-out one. All time comparisons use the database clock.

**Residual risk.** A timed-out append that Google processes more than 120 s later could land after the retry's check, which would produce a second row and a second email. The 120-second gap makes that unlikely but can't rule it out, because the Sheets API gives no way to cancel a request. Worst case is one duplicate test email to an owner mailbox. P4.2 tests the replay paths, and the claim is "no duplicate under the tested failures", not "exactly once".

**Bounds.** Sheet capped at 2,000 rows; the owner archives by hand before that. A Zapier Free account has 100 tasks a month, and only the owner workspace produces rows. The dispatcher sends at most 3 events per cron tick to stay inside 10 ms of CPU.

**As built (P4.3), tested only against the labeled double in `tests/integration/sheets-double.ts`.** `backend/src/integrations/sinks.ts`. The token is signed with `jose` (already a dependency) and held per isolate. A 401 on a Sheets call gets one token refresh inside the attempt. At 2,000 rows the bridge dead-letters with `sheet_full` instead of appending. Cells that would start a formula get a leading apostrophe, and input is `RAW` anyway. The test double is honored only when `ENVIRONMENT` is `local` and only as an in-process function (D-060). **P4-C stays Pending Owner Credentials**: no real sheet, service account or Zap exists.

**Evidence.** Accepted says the row exists. Whether the email arrived is known only from the Zap run, which the owner records through the confirm endpoint.

## Mode B: webhook

Optional and paid; off without approval. Same sink interface, with the event ID in the payload. The hook URL is a secret. A 200 sets Provider Accepted and nothing more.

## AI gateway

```ts
interface ReviewProvider {
  readonly label: "Deterministic demonstration fixture" | "Live model output";
  review(input: { documentSha256: string; segments: Segment[]; promptVersion: string }): Promise<ReviewOutput>;
}
```

The fixture provider is keyed by document hash. Live provider stays absent until DEC-002. Output must pass the strict schema from PRD 10.2, and `extractedFields` must cite real segment IDs, or the result is rejected as Failed and never coerced.

## Dispatch timing

`ctx.waitUntil` runs one bounded dispatch pass for the workspace whose command just committed (`backend/src/jobs/afterCommit.ts`, D-058). The sweep at `*/30 * * * *` catches the rest. It does nothing else unless due rows exist, so it wakes Neon only for the time one indexed query takes, plus the 5-minute autosuspend tail.
