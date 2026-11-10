# Prioritized outcome backlog

Order follows PRD Section 14 dependencies. The value column is a judgment, not a measurement.

| # | Outcome | Phase | Value | Risk | Why here |
|---|---|---|---|---|---|
| 1 | One URL, isolated guest demo, real owner boundary | P1 | High | High | Isolation failures would end the project |
| 2 | Persisted cases, handoffs, atomic approvals, audit | P2 | High | Medium | Proves it's a system and not a mock |
| 3 | CRM and ERP simulators, repeat-safe sync, findings | P3 | High | Medium | The role's center of gravity |
| 4 | Outbox dispatch and a verified Zap | P4 | High | Medium | Names a posting tool and shows reliability |
| 5 | Fixture AI review, human decision, eval suite | P5 | High | Medium | Live AI waits for a provider decision |
| 6 | Dashboards, reports, ROI scenarios | P6 | Medium | Low | Needs real records first |
| 7 | Security, restore, rollback, accessibility gate | P7 | High | Medium | Required before anyone else sees it |
| 8 | Demo, case study, handoff | P8 | High | Low | The thing an interviewer sees |

## Iteration log

| Iteration | Intended | Actual | Adjustment |
|---|---|---|---|
| P0 | Design and proofs before code | See `docs/reports/P0.md` | Guests never trigger PDF parsing, because the proof showed it can't fit Workers Free |
