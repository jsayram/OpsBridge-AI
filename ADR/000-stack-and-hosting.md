# ADR-000: Stack and hosting

- **Status:** Owner-selected direction. Locally provable items were run on 2026-11-06 (see below). One sub-item failed: PDF extraction does not fit the Workers Free CPU limit, and it needs Jose's decision (DEC-003). Items that need Neon or Hyperdrive stay Pending Owner Credentials/Configuration.
- **Date:** November 6, 2026 (America/New_York)
- **Decider:** Jose Ramirez (master inbox DEC-001)

## Decision

Build OpsBridge AI in TypeScript on Cloudflare Workers, with PostgreSQL as the database, reached through Hyperdrive. One Worker serves the React assets and `/api` from a single HTTPS origin. Neon Free is the planned database provider, and the app starts on the Workers Free plan.

Hono, Drizzle and Vitest were approved for local use by Jose on 2026-11-06. Private R2 storage and Cloudflare Access for owner login stay proposals until DEC-002 is answered. An ERP simulator inside the same Worker is the working design (`DECISIONS.md` D-010).

This decision approves no account, provisioning, spending, deployment or publication.

## Why

- The posting asks for "at least one modern programming language" and names JavaScript/TypeScript. Jose is comfortable defending TypeScript in an interview.
- "Strong SQL and data modeling skills" is a must-have, and the data duties center on one trusted source of truth. PostgreSQL gives real transactions, role-enforced grants and `EXPLAIN ANALYZE` evidence.
- Jose wanted to stay on Cloudflare if he could. Workers need no server kept awake, which removes the cold-start and always-on problems of a container host.
- Cloud is a nice-to-have with Azure and AWS as examples. Cloudflare counts as cloud work but must not be described as either.

## Alternatives

| Option | Outcome |
|---|---|
| ASP.NET Core and PostgreSQL on Railway or Azure | Rejected. A host like this was only needed for C#, which Jose dropped. |
| PlanetScale Postgres at $5 a month | Rejected for now. It stays awake and is the likely upgrade path, but Jose wants the free option because this is a demo. |
| Convex | Rejected. It has strong transactions and scheduling, but no SQL, which the posting makes a must-have. |
| Workers, D1 and R2 | Rejected. It is the simplest and cheapest, but it weakens the SQL evidence. D1 has no interactive transactions, and its SQLite base has no database role grants as far as we know. |
| ASP.NET Core in Cloudflare Containers with external PostgreSQL | Rejected. It has the most moving parts, and containers sleep when idle. |

## Consequences

- Development is local first: Postgres in Docker plus `wrangler dev`, connected through `localConnectionString`. The core app needs no Neon or Cloudflare account during the build. Local runs skip Hyperdrive, so transaction tests must also run against real Hyperdrive before release.
- Neon is a separate provider, so this is not Cloudflare-only. The Neon account must be owned by Jose.
- Workers Free allows 100,000 requests a day, which is well beyond demo traffic. The real limit is 10 ms of CPU per request and per cron run. Workers Paid at $5 a month lifts it to 5 minutes. The P0.2 measurement confirmed that PDF extraction needs it for anything past a few pages.
- Neon sleeps after 5 idle minutes, so a first visitor may wait for it to wake. Keeping it awake isn't an option on the free plan.
- Neon Free has 100 CU-hours a month. Running out suspends the database until the next billing period, and exceeding 1 GB of storage blocks writes. So events are dispatched right after commit, with a cron sweep about every 15-30 minutes, and demo cleanup has to work.
- Neon Free has a 6-hour restore window, so scheduled `pg_dump` backups to R2 are needed for the restore rehearsal.
- Hyperdrive's read cache is not invalidated by writes, so caching stays off for this app.
- Hyperdrive pools in transaction mode, so transactions stay short and any `SET` runs inside each transaction.
- A managed database endpoint may be internet-reachable. PRD Section 6.3 now requires compensating controls and owner review for that case.
- Cost starts at $0 before AI usage or a domain, and becomes $5 a month if Workers Paid is needed. Neon's staging branches share the project's compute hours.

## Proof items

Prototype: `spikes/p0.2/`. Evidence: `docs/evidence/P0.2/`. Report: `docs/reports/P0.2.md`. All numbers below come from an Apple Silicon Mac running workerd locally. Cloudflare's hardware will differ, so treat them as a lower bound until a deployed Worker reports its own CPU time.

| # | Item | State | Result |
|---|---|---|---|
| 1a | PDF text extraction works in workerd | Proven locally | `unpdf` 2.1.0 extracted correct text under `wrangler dev`. An image-only PDF returns 0 characters. A malformed PDF throws, and the app must map that to a failed state. |
| 1b | Extraction fits Workers Free 10 ms | **Failed** | 1 page 4.7 ms warm, about 40 ms in a cold isolate. 5 pages 13.1 ms. 20 pages 45.9 ms. It fits Workers Paid. Bundle is 2.7 MB uncompressed against the 64 MiB limit. DEC-003 holds the decision. |
| 1c | Normal requests fit 10 ms | Proven locally, margin unknown in production | No-op 1.3 ms, read 3.8 ms, full approval 4.4 ms of OS CPU per request, with runtime overhead included. Recheck on Cloudflare at P1.5. |
| 2 | Approval transaction under concurrency | Local pass; **Pending Owner Credentials** for Hyperdrive | 20 concurrent decisions over 30 rounds: one winner, 19 typed conflicts, one audit row, one outbox row. Local mode skips Hyperdrive. |
| 3 | Isolation, least privilege, cleanup beside append-only audit | Local pass | 21 checks, including RLS on a reused connection and the audit guard. The rule is in PRD 7.4. |
| 4 | Dispatch survives failure and replay | Local pass with a simulated sheet; real Sheets pending | Crash after write replays with no duplicate. Eight parallel dispatchers never double-claim. Cron sweep recovers events that were never dispatched. |
| 5 | Database network exposure | **Pending Owner Configuration** | Treated as internet-reachable with TLS and least-privilege roles. Residual risk is in `THREAT-MODEL.md`. Needs a real Neon project to confirm, then owner review. |
| 6 | Backup and clean-room restore | Local pass; Neon and R2 pending | `pg_dump` into a clean database: counts and hashes match, and RLS, grants and the audit guard all survive. |
| 7 | Neon wake-up delay | **Pending Owner Credentials** | Neon says "typically within a few hundred milliseconds". Not measured. Target and loading behavior are in PRD 13.2. |
| 8 | Current limits and prices | Confirmed 2026-11-06 from vendor pages | `docs/design/COST-INVENTORY.md`. Reconfirm before accounts exist. |

Two corrections came out of the price check. Neon's Free allowance is 100 CU-hours rather than plain compute hours, so capping the compute at 0.25 CU gives 400 hours. Workers no longer has a compressed size limit; the limit is 64 MiB uncompressed.

## Reversal

A failed proof item, or a change of mind by Jose, reopens this decision through an updated ADR. If Workers cannot do document extraction, consider moving only that job elsewhere before changing the whole stack.
