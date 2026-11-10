# Sprint and decision history

How the project was actually run, from the repository's own records. Each phase was one working session (a "sprint" in the loose sense), planned in a brief, run on its own branch, reported with evidence, and reviewed by a coordinator before the next started.

**Context to state plainly.** One person, Jose Ramirez, set the goals and made every owner decision. The planning, coding and reviews were done with AI coding tools: a coordinating session assigned each phase to a fresh implementation session, and some reviews were run by a separate AI agent. No human team was managed, and no human code review has happened. This is a record of process design and delivery, not of leading people (PRD JOB-06, JOB-15).

## Timeline

| Phase | Date | Branch | Delivered | Coordinator review |
|---|---|---|---|---|
| Planning | 2026-11-05 | (vault and PRD) | PRD v1.1 to v1.3, job alignment, roadmap | Planning only |
| P0 Foundation | 2026-11-06 | `phase/p0-foundation` | Stack ADR with 42 local database proofs, threat model, design docs, prototypes, scaffold, local CI | Accepted for limited scope at `601854a` |
| P1 Shell and identity | 2026-11-06 | `phase/p1-shell` | Guest sessions, reset, quotas, cron purge, owner identity on a test double, shell UI | Accepted for limited scope at `12d1172` |
| P2 Records and audit | 2026-11-06 | `phase/p2-core` | Case workflow, checklists, handoffs, approvals, audit, outbox insert | Accepted for limited scope at `21dfc35` |
| P3 Integrations | 2026-11-06 | `phase/p3-integration` | Simulators, sync with cursors, reconciliation findings, inventory, Salesforce connector on a double | Accepted for limited scope at `bf7a396` |
| P4 Automation | 2026-11-09 | `phase/p4-automation` | Typed rules, dispatcher, delivery labels, Sheet bridge on a double, operator controls | Accepted for limited scope at `ae52ad6` |
| P5 AI review | 2026-11-09 | `phase/p5-ai-review` | 40 fixture documents, cited review, human decision, live gateway on a double, evaluation | Accepted for limited scope at `e2defce` |
| P6 Analytics | 2026-11-09 | `phase/p6-analytics` | Metric glossary, dashboards, reports with safe CSV, ROI calculator, business case | Accepted for limited scope at `41c6668` |
| P7 Hardening | 2026-11-09 | `phase/p7-release-gate` | Scans, negative sweep, outage drills, rollback and restore rehearsals, incident runbook, WebKit, load profile | Accepted for limited scope at `db40c7f` |
| P8 Launch prep | 2026-11-09 | `phase/p8-launch-prep` | Guided demo, evidence page, case study draft, handoff docs, launch checklist, evidence matrix | Waiting for review |

The ledger (`docs/PHASE-LEDGER.md`) has the exact verification and the gate record for each.

## How each phase ran

1. **Brief.** Goal, packages, acceptance criteria, stop points and the routing rule (`docs/briefs/`).
2. **Build on a branch** cut from the last accepted head. Phase branches stack; nothing merges into `main` without the owner.
3. **Verify.** Narrow tests while working, `npm run ci:local` on a clean copy at the end.
4. **Report** with evidence paths, what was not run and why, and what the owner must do (`docs/reports/`).
5. **Coordinator review.** The coordinating session reran the local CI, read the evidence and recorded the result. Owner acceptance is a separate field that stays empty until Jose gives it.

## Decisions that changed the plan

| When | Decision | Why it mattered |
|---|---|---|
| 2026-11-06 | TypeScript on Workers with Postgres (DEC-001, ADR-000) | Picked from four candidates after comparing cost, transactions and job relevance |
| 2026-11-06 | Free Cloudflare and Neon, created by Jose (DEC-002) | Keeps the project at $0 and keeps accounts in the owner's hands |
| 2026-11-06 | Defer every live-account criterion (DEC-007, DEC-008) | Let the build continue on labeled doubles instead of stalling on accounts |
| 2026-11-09 | Stay free, fixtures only for documents (DEC-003) | PDF parsing failed the 10 ms CPU proof; the owner chose no paid plan |
| 2026-11-09 | Expand and contract split of the dispatcher migration (P7) | A rollback rehearsal showed the first version would break the previous release |

The full log is `DECISIONS.md` (79 entries) and `docs/MASTER_INBOX.md` (the owner's own words for each decision).

## Retrospective notes

What worked:

- Rehearsing instead of assuming. The rollback rehearsal and the restore drill each found a real problem before any host existed.
- Labels as data. Because delivery state and provenance are stored, the UI and the recap can't overstate them.
- A test that sweeps every API operation from the spec, so a new route can't skip the negative checks.

What to change next time:

- Browser intermittents took too long to explain. The WebKit "New case" miss turned out to be a layout shift (P8.1); measuring element positions earlier would have found it in P7.
- The README trailed the code for several phases. Updating it per phase is cheaper than one rewrite.
- No human has reviewed the code. Getting one independent review before a public launch matters more than another AI pass.
