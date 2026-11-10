# Connector runbook and fault report

For whoever operates the integrations page. Everything on it is simulated unless it says Connected Test. No real Salesforce org or NetSuite account has been connected.

## How a sync behaves

1. A run reads one page, then commits that page and the cursor after it in one short transaction.
2. Transient failures retry 3 times with jittered backoff, 8 seconds per attempt.
3. If they keep failing, the run stops at `failed` with its cursor saved. A credential, permission or payload problem goes straight to `dead_letter`, with no retries.
4. The connection's own cursor moves only when a whole run succeeds, so a failed run can't skip records.
5. At the end, detection runs in the same transaction as the success, and only findings with new evidence are added.
6. A record counts as deleted at source only after a full read with no rejected records that actually returned that record type.
7. Hosted, a run does one page per request (`SYNC_PAGES_PER_CALL`), and the browser carries on until it finishes. Closing the page leaves the run paused, with its cursor saved. Its lease lapses and the next person to sync closes it.

## What to do

| You see | It means | Do this |
|---|---|---|
| Failed safely, `http_5xx`, `timeout` or `network_error` | The source stopped answering | Check the source, then **Resume from saved cursor** |
| Failed safely, `http_429` | Rate limited past the retry budget, or asked for a wait over 10 seconds | Wait, then resume |
| Needs an operator, `http_401`, `token_revoked` | Credentials are bad | Fix or reconnect, then resume. Cases and the demo keep working |
| Needs an operator, `http_403` | The integration role lost access | Fix the role, then resume |
| Needs an operator, `malformed_json`, `unexpected_shape` | The source sent something unreadable | Nothing from that page was kept. Raise it with the source owner, then resume |
| Needs an operator, `cursor_unreadable` | The saved position can't be read | Start a new full sync |
| Needs an operator, `token_unreadable` | The stored token can't be decrypted, usually a changed key | Disconnect, which still scrubs, then connect again |
| `retry_exhausted` | Five resumes used | Start a new sync |
| `run_superseded` | A newer sync ran since this one failed. Finishing the old one would misread the source | Start a new sync |
| `resume_required` | Continue only carries on a healthy run | A Manager resumes it |
| `evidence_stale` on an approval | The customer or the stored source record changed since the finding was raised | Run a sync and review what it finds |
| `lease_expired` on an old run | A Worker died mid-run | Nothing to do. The next sync closed it |
| Rejected count above 0 | Records failed validation or carried a privileged field | See `rejected_sample` on the run. The rest of the page was kept |
| Unknown fields dropped above 0 | The source added a field | Decide whether to map it. It was not stored |

Connection status returns to normal on the next successful run. A status change to Degraded emits `integration.degraded` into the outbox, which P4 dispatches.

## Fault report

Every fault runs against real Postgres through the real routes, in `tests/integration/faults.test.ts`, `sync.test.ts` and `inventory.test.ts`. The fault names are a closed list in `backend/src/integrations/scenarios.ts`, and a guest can only pick from it.

| PRD 8.4 or build-task fault | Scenario | Result |
|---|---|---|
| 401 | `http_401` | Dead letter at once, no retries, Degraded, cases still work |
| 403 | `http_403` | Dead letter at once |
| 429, then success | `http_429` | Recovers inside the retry budget |
| 429 for too long | `http_429_long` | Fails without sleeping, cursor kept |
| Transient 5xx | `http_5xx_transient` | Recovers inside the retry budget |
| Outage | `http_5xx_outage` | Failed after 4 attempts, cursor kept, resume finishes with no duplicate |
| Timeout | `timeout` | Transient. The real 8-second abort is proven in a unit test |
| Duplicate event | `duplicate_event` | One row each |
| Out-of-order event | `out_of_order` | Newest values stay |
| Renamed customer | `renamed_customer` | New finding that links the old one, canonical name unchanged |
| Stale version | `stale_version` | Skipped and counted, nothing changes |
| Deleted record | `deleted_record` | Marked deleted at source, finding opened, customer kept |
| Mismatched account ID | `mismatched_account` | High finding, account unchanged until approved |
| Malformed payload | `malformed_payload` | Dead letter, nothing from that page kept |
| Unknown field | `unknown_field` | Dropped, counted, not stored |
| Unknown privileged field | `privileged_field` | That record rejected, the rest kept |

## Salesforce Developer Edition, owner steps

Pending Owner Credentials. These steps have not been run. The connector has only met the test double, so expect to correct this section the first time.

1. Sign up for a free Developer Edition org yourself.
2. Create a user for the connector with a read-only permission set: read on Account, nothing else. Salesforce has no read-only OAuth scope, so this user is what keeps it read-only at the org.
3. Create an external client app with the OAuth web server flow, PKCE required, refresh token rotation on. Scopes: `api`, `refresh_token`. Callback: `<origin>/api/v1/admin/integrations/salesforce/callback`.
4. Generate a key with `openssl rand -base64 32`. Set it as the Worker secret `TOKEN_ENCRYPTION_KEY`, and the client secret, if the app needs one, as `SALESFORCE_CLIENT_SECRET`. Never paste either into a chat, a note or a command line that gets saved.
5. Set `SALESFORCE_ENABLED`, `SALESFORCE_LOGIN_URL`, `SALESFORCE_CLIENT_ID` and `SALESFORCE_REDIRECT_URI` in the Worker config.
6. In `/admin`, choose **Connect read-only test org** and approve with the read-only user.
7. To prove P3-D, run through connect, read, pagination, an expired token, revoke and disconnect, and keep redacted evidence in `docs/evidence/P3.3/`.

## Revocation

- **Normal:** `/admin`, **Disconnect and revoke**. That calls the provider's revoke endpoint, then scrubs the ciphertext here. If the provider call fails, the token is still removed here and the page says the revoke didn't confirm.
- **If that fails or the app is unreachable:** in Salesforce, Setup, Connected Apps OAuth Usage, revoke the user's token. The next read goes to `dead_letter` with `token_revoked`.
- **Suspected key exposure:** revoke at Salesforce first, disconnect, set a new `TOKEN_ENCRYPTION_KEY`, reconnect. Old ciphertext can't be read with the new key, which is fine because it was scrubbed. There is no re-encryption tooling.

Guests are never affected: a demo workspace can't hold a live connection, by database trigger.

## Local checks

Run with Node 22 on the path.

```bash
npm run -s test:integration -- tests/integration/faults.test.ts
```

```bash
node scripts/connector-proof.mjs
```
