# Metric specification (P6)

Definitions version `metrics-1`. Code: `backend/src/domain/metrics.ts` (glossary), `backend/src/repo/analytics.ts` (queries), `backend/src/repo/reports.ts` (reports). Tests recompute every count from the raw rows in JavaScript, with no shared SQL: `tests/integration/analytics.test.ts`.

## Scope

A metric counts the rows the caller can already see in the case list:

- a demo guest: its own workspace plus the read-only shared template (the "shared samples");
- the owner: the owner workspace only.

Another visitor's workspace is never in scope. RLS enforces the same boundary underneath.

## Provenance (PRD 11.2)

| Label | Meaning | Where it appears |
|---|---|---|
| SYNTHETIC | Counted exactly from fictional records | Every count over cases, findings, reviews, events and sources |
| MEASURED_DEMO | Measured from actions taken in this workspace; real timing, tiny sample | Median minutes from AI review request to decision |
| ESTIMATED | Calculated from stated assumptions | Manual steps avoided; every ROI output |
| UNKNOWN | No source exists yet; no value is shown | Live AI cost while live AI is Pending Owner Credentials; sync age before any sync |

Unknown is never shown as zero.

## Glossary

| Key | Formula | Provenance |
|---|---|---|
| open_cases | Cases with status Intake, Needs Review or Ready | SYNTHETIC |
| completed_cases | Cases with status Approved or Closed | SYNTHETIC |
| draft_cases | Cases with status Draft (outside the funnel denominator) | SYNTHETIC |
| review_queue | Cases with status Needs Review | SYNTHETIC |
| review_age_max | Whole days since creation of the oldest Needs Review case. Cases keep no time of entry to a status, so this is age since creation | SYNTHETIC |
| overdue_open | Open cases with due date before now | SYNTHETIC |
| open_findings (exception queue) | Findings not Resolved and not Dismissed | SYNTHETIC |
| findings_resolved, findings_dismissed | Findings with that status | SYNTHETIC |
| oldest_unresolved | Whole days since `detected_at` of the oldest unresolved finding | SYNTHETIC |
| last_sync_age | Hours since the newest `last_success_at` across the scope's connections; empty if none | SYNTHETIC or UNKNOWN |
| completion_rate | (Approved + Closed) / all non-Draft cases; empty when the denominator is 0 | SYNTHETIC |
| funnel `reached` | Cases in a stage plus every later stage | SYNTHETIC |
| documents, ai_reviews, ai_abstained | Document rows; review rows; reviews with an abstain reason | SYNTHETIC |
| ai_decision_minutes | Median minutes from `requested_at` to `decided_at`, own workspace only | MEASURED_DEMO, or UNKNOWN before any decision |
| ai_live_cost | Sum of `ai_usage.cost_micro_usd`, shown only once a configured live provider has been called | UNKNOWN today |
| automation labels | Each outbox row mapped by the PRD 7.2 rule to Queued, Accepted, Confirmed, Failed or Simulated. Nothing is ever Delivered | SYNTHETIC |
| automation_retries | Sum over events of attempts beyond the first | SYNTHETIC |
| automation_failed | Events in `dead_letter` | SYNTHETIC |
| manual_steps_avoided | (Accepted + Confirmed + Simulated) x 3 assumed steps per notice | ESTIMATED |

The AI section also shows the P5.5 fixture evaluation (`docs/evidence/P5.5/eval-report.json`), labeled as fixture results, never as model accuracy. A unit test holds the copied numbers to the report.

## Snapshots

`app.metric_snapshots` (migration `0009`) stores one value per workspace, metric and UTC day for `open_cases`, `completed_cases`, `review_queue`, `open_findings` and `automation_failed`. A rate stores numerator and denominator, never the division.

- The shared template holds a fixed 90-day SYNTHETIC history, dated by the pack clock (2025-10-18 to 2026-01-15). Its last day equals the template's live count; a test checks that.
- A manager or the owner can record today's values for their own workspace (`POST /api/v1/analytics/snapshots`). It upserts, so a repeat replaces the day, and it writes an audit row. RLS refuses a write to the template.
- Purge removes a demo workspace's snapshots.

Live dashboard numbers never come from snapshots. Snapshots only draw the trend.

## Reports and export (P6.3)

| Limit | Value |
|---|---|
| Date range | UTC days, inclusive, at most 366; defaults to the last 366 days |
| Page size | 1 to 100 |
| Deepest page | (page - 1) x limit at most 5,000 |
| Export | At most 1,000 rows; a larger result is refused with 413 `export_too_large`, never truncated |
| Parameters | Only `from`, `to`, `status`, `assignee`, `source`, `sort`, plus `page` and `limit` on the table. Anything else, or a repeat, is a 400 |

The table, the totals by status (the chart) and the CSV are built from one WHERE clause, so identical inputs give identical counts. `source` matches a case whose client has a linked record from that simulated system; `none` means no linked record.

CSV: every cell is quoted and inner quotes doubled. A cell starting with `=`, `+`, `-`, `@`, tab, carriage return or their full-width forms gets a leading apostrophe. Each row carries `SYNTHETIC` in a Provenance column.

## Query plans

`tests/profile/analytics-profile.test.ts` runs every analytics and report query under `EXPLAIN ANALYZE` as `opsbridge_app` with RLS on, at 1,001 owner cases. Output: `docs/evidence/P6.1/query-plans.txt`. All were under 6 ms locally. The report scans `cases` sequentially for a whole-year range because the range covers nearly every row; no index is added (D-070). Re-read at first deploy on Neon.
