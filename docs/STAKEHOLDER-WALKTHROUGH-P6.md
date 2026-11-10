# P6 walkthrough: analytics, reports and ROI

A ten-minute tour for someone who won't read code. Run it locally (`npm run dev`, then open the demo) or on staging once it exists. Everything you see is fictional data, and the screens say so.

## 1. Analytics (`/app/analytics`)

**What it answers:** how much work is open, where it's stuck, whether the sources are fresh, how AI review and notifications are doing.

- **Operations pulse.** Open cases, completed cases, drafts, the review queue, the oldest case in review, overdue cases, the exception queue and hours since the last successful sync. Each card shows its formula under the number and a label: *Synthetic* (counted from fictional records), *Measured in demo* (timed in your session), *Estimated* (from an assumption) or *Unknown* (no source yet).
- **Workflow funnel.** Cases in each stage, and how many reached it. Completion rate is Approved plus Closed over every non-draft case.
- **Integration health.** One row per source. Every one says *Simulated*; nothing on this page is a live system. A source that never synced says *Never*, and the sync-age card says *Not available* rather than zero.
- **Data quality.** Findings by kind, resolved and dismissed counts, and the oldest unresolved one.
- **AI assistance.** Review counts, abstentions and the P5 evaluation, marked "Fixture evaluation, not model accuracy". Live AI cost shows *Not available*, because no provider is configured. It is never shown as $0.
- **Automation.** Events by the five delivery labels. *Accepted* means the receiving service took the request; delivery isn't confirmed. Nothing is ever called Delivered. "Manual steps avoided" is labeled *Estimated*: three assumed steps per notice.

Try it: approve a Ready case as a manager, come back, and Completed goes up by exactly one. A manager can press **Record today's snapshot** to add today's values to the trend.

Every chart has a table with the same numbers beside it, and each metric is a heading, so a screen reader can jump between them.

## 2. Reports (`/app/reports`)

**What it answers:** "show me these cases, and let me take them away in a spreadsheet."

Filter by date (UTC), status, assignee and source, sort, and page through. The count in the heading, the per-status table and the CSV always agree, because they come from one query. Limits are written on the page: 366 days per report, 1,000 rows per export. A bigger export is refused with a message to narrow the filters, never cut short. Text that a spreadsheet would run as a formula (starting with `=`, `+`, `-` or `@`) is exported with a leading apostrophe, so it opens as text.

## 3. ROI (`/app/roi`)

**What it answers:** under stated assumptions, is this worth doing?

Change any assumption and the projection updates at once. Each input shows where its default came from; all are assumptions, and the hourly rate is a placeholder. Three presets compare conservative, base and optimistic cases. The conservative case loses money, and that's deliberate: it shows the answer depends on review time and exceptions. The sensitivity table shows which inputs matter most. A panel at the bottom shows time actually measured in your session, kept apart from the projection.

The one-page decision memo built from these numbers is `docs/EXECUTIVE-BUSINESS-CASE.md`.

## For the phase review (JOB-TEST-08)

| Topic | Short answer |
|---|---|
| Business purpose | Turn recorded work into numbers a manager can act on, and test a business case without inventing results |
| Data flow | Browser asks the API; the Worker runs grouped SQL over the caller's rows inside one transaction; nothing is cached; snapshots only feed the trend |
| Security boundary | A guest sees its workspace plus read-only shared samples; RLS enforces it again in the database; unknown parameters are refused; export is capped and formula-safe |
| Failure path | A failed query shows an error card with a retry and the request ID; an over-cap export or bad date range returns a clear message; no source shows Unknown, not zero |
| Tests | Integration recount of every metric before and after changes, report/CSV agreement on nine filter sets, F8 formula payloads, limits and cross-workspace refusal, ROI arithmetic, business-case figures, browser tests on desktop and phone with axe |
| Trade-off | Live recomputation over materialized metrics: always reconciles, costs nine small queries per view (plans under 6 ms at 1,001 cases locally) |

Not covered yet: a screen-reader run with VoiceOver, and Safari. Both are carried to P7.4.
