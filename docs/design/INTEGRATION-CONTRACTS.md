# Integration contracts

Every source and sink sits behind a typed adapter. The public demo uses the simulated adapter of each. Labels follow PRD 4.3.

## Source adapter (CRM, ERP, inventory)

```ts
interface SourceAdapter<T> {
  readonly provider: "crm" | "erp" | "inventory";
  readonly mode: "simulated" | "connected_test";
  list(input: { cursor?: string; limit: number }): Promise<Page<SourceRecord<T>>>;
  health(): Promise<{ status: "ok" | "degraded"; detail: string }>;
}
type SourceRecord<T> = { externalId: string; externalVersion: string; observedAt: string; data: T };
type Page<T> = { items: T[]; nextCursor?: string };
```

| Rule | Applies to |
|---|---|
| Timeout 8 s, retries 3 with jittered backoff, 429 honors `Retry-After` | All |
| 401, 403 and validation errors don't retry | All |
| Cursor advances only after the page commits | All |
| Unknown fields are dropped and counted, never stored raw | All |
| Fault modes 401, 403, 429, 5xx, timeout, duplicate, out-of-order, renamed, stale, deleted, mismatched ID | ERP simulator (PRD 8.4) |
| OAuth with PKCE, read scopes only, owner-started, refresh token server-side | Salesforce adapter |
| Item code, quantity, unit, location, external version, source timestamp; read-only | Inventory simulator |

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

**Sequence.** Dispatcher holds a 60-second lease for the event.

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
| Worker dies mid-attempt | Lease expires; next tick reclaims; check finds any row already written |

**Why two dispatchers can't race.** Only the lease holder works on an event. Both calls together take at most 20 s, so they end well inside the 60-second lease, and `claim_due_outbox` uses `SKIP LOCKED`. All time comparisons use the database clock.

**Residual risk.** A timed-out append that Google processes more than 120 s later could land after the retry's check, which would produce a second row and a second email. The 120-second gap makes that unlikely but can't rule it out, because the Sheets API gives no way to cancel a request. Worst case is one duplicate test email to an owner mailbox. P4.2 tests the replay paths, and the claim is "no duplicate under the tested failures", not "exactly once".

**Bounds.** Sheet capped at 2,000 rows; the owner archives by hand before that. A Zapier Free account has 100 tasks a month, and only the owner workspace produces rows. The dispatcher sends at most 3 events per cron tick to stay inside 10 ms of CPU.

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

`ctx.waitUntil` runs one dispatch for the event just committed. The sweep at `*/30 * * * *` catches the rest. It does nothing else unless due rows exist, so it wakes Neon only for the time one indexed query takes, plus the 5-minute autosuspend tail.
