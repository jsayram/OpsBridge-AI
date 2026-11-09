# Automation operator guide

P4, written 2026-11-09. Covers the outbox dispatcher, delivery labels, the owner's controls, and the steps Jose follows to connect a real Google Sheet and Zap. **Nothing in this guide has run against a real sheet or Zap yet. P4-C is Pending Owner Credentials.**

## How an event moves

1. A command (approve a case, resolve a finding, a sync that degrades) commits its change and writes one outbox row in the same transaction. A duplicate click can't write a second row: the idempotency key is unique.
2. Right after the response, the Worker runs one bounded dispatch pass for that workspace. The cron at `*/30 * * * *` catches anything missed, at most three events a tick.
3. The dispatcher claims the event with a 130-second lease, reads the workspace's enabled rules, and picks the sink from the workspace mode in the database. A demo workspace always gets the simulated sink.
4. It delivers with no transaction open, then records the result with the lease token. A crash anywhere leaves the event to be claimed again once the lease runs out, and the sink's check makes the repeat harmless.

## What the labels mean

| Label | Means | Doesn't mean |
|---|---|---|
| Queued | Waiting for the dispatcher, a retry, or the end of an emergency stop | Lost |
| Simulated | Recorded here. Nothing left the system | Sent |
| Accepted | Google stored the sheet row | Anyone received an email |
| Confirmed | The owner recorded a Zap run reference | Proven by the app itself |
| Failed | Permanent error, or six attempts | Gone. Retry is one click |

"Delivered" is never shown. Mode A has no callback, so most real events end at Accepted, and that's the honest state.

**Timing.** "Next try no earlier than" is a floor, not a schedule. A retry runs on the next pass after that time: the 30-minute cron, three events a tick across every workspace, or sooner if another command commits in the same workspace, or the owner presses dispatch. A 2-minute backoff can take up to 30 minutes in practice.

## Owner controls, on `/admin`

| Action | When | Effect |
|---|---|---|
| Emergency stop | Something is sending what it shouldn't, or the sheet is misbehaving | Every claim, demo and owner, returns nothing. Events wait as Queued. A reason is required and audited |
| Resume | The cause is fixed | Next pass picks up everything waiting |
| Retry | A run is Failed and the cause is fixed | Failed → Queued with attempts reset; old attempts stay in history. Audited. A duplicate click gets 409 |
| Confirm | A run is Accepted and you saw the Zap run | Records the reference, label becomes Confirmed. Audited. Only from Accepted |

Error codes on a run: `provider_unavailable` (5xx or network), `timeout`, `rate_limited` (honors `Retry-After`), `sheet_auth` (token trouble after one refresh), `sheet_forbidden` (403, the share is broken), `sheet_not_found` (404), `sheet_full` (2,000 rows; archive the sheet by hand), `lease_expired` (a Worker died mid-attempt), `sink_error`.

## Rules

Rules live on `/app/automations` for demo visitors and the owner. Each has a trigger from the five event types, a condition built only from listed fields and values (team, case type, reason, decision, finding kind, source), and one of two actions: append to the owner's test sheet, or record a simulated notice. A rule holds no address, link, recipient or code, so there is nothing to type a destination into. A change makes a new version, and every effect records the version it ran under.

**Reuse (JOB-TEST-06).** "Reuse for Seasonal Staffing" creates a linked rule that differs only in the team. The same evaluator serves both; one reuse per team.

## Rehearse locally

```bash
npm run test:integration -- tests/integration/dispatch.test.ts tests/integration/automation-operator.test.ts tests/integration/automation-rules.test.ts
```

The Sheet path runs against the labeled double in `tests/integration/sheets-double.ts`, which follows Google's public request shapes. It is not Google.

## Connecting a real sheet and Zap (Jose only, needs approval)

These are stop points: account access, a credential and an external send. Don't start until Jose has approved the recipient and purpose through the master inbox.

1. **Sheet.** In Jose's Google account, create a sheet named `OpsBridge test events`. Rename the first tab `Events`. Row 1: `event_id`, `event_type`, `occurred_at`, `case_ref`, `summary`, `mode`.
2. **Service account.** In a Google Cloud project Jose owns, enable the Sheets API, create a service account with no project roles, and create one JSON key. Share the sheet with the service account's email as **Editor**, and with nobody else.
3. **Worker secrets.** `wrangler secret put GOOGLE_SA_KEY` (paste the JSON), then set `SHEET_ID` to the ID from the sheet URL and `SHEETS_ENABLED=true`. Never commit the key.
4. **Zap.** In Jose's Zapier account: trigger *Google Sheets → New Spreadsheet Row* on that sheet and tab; action *Email by Zapier → Send Outbound Email* (or Gmail) to a mailbox Jose controls, subject `OpsBridge TEST {{event_type}} {{case_ref}}`. Both are non-premium. Don't add a webhook step: that needs a paid plan and separate approval.
5. **Run once.** Approve the owner sample case. The run should show Accepted with a row range. Zapier Free polls about every 15 minutes, so the email can take that long. When it arrives, copy the Zap run ID from Zap history and record it with Confirm.
6. **Evidence for P4-C.** The run's attempt history, the sheet row, the Zap history entry, and the received email header, all with the event ID. Save screenshots with nothing private in them.

## Revoking

- In the sheet, remove the service account's share. The next attempt dead-letters as `sheet_forbidden`; nothing else is affected.
- In Google Cloud, delete the service account key, then `wrangler secret delete GOOGLE_SA_KEY` and unset `SHEETS_ENABLED`. Owner events then finish as Simulated.
- In Zapier, turn the Zap off.
- Use the emergency stop first if you're unsure what's sending.
