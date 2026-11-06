# ADR-000: Stack and hosting

- **Status:** Owner-selected direction. P0.2 is not accepted, and the proof items below are open.
- **Date:** November 6, 2026 (America/New_York)
- **Decider:** Jose Ramirez (master inbox DEC-001)

## Decision

Build OpsBridge AI in TypeScript on Cloudflare Workers, with PostgreSQL as the database, reached through Hyperdrive. One Worker serves the React assets and `/api` from a single HTTPS origin. Neon Free is the planned database provider, and the app starts on the Workers Free plan.

Hono, Drizzle, Vitest, private R2 storage, Cloudflare Access for owner login and an ERP simulator inside the same Worker are proposals. They become decisions in their own P0.2 entries.

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
- Workers Free allows 100,000 requests a day, which is well beyond demo traffic. The real limit is 10 ms of CPU per request and per cron run. Workers Paid at $5 a month lifts it to 5 minutes, and PDF extraction will probably need that.
- Neon sleeps after 5 idle minutes, so a first visitor may wait for it to wake. Keeping it awake isn't an option on the free plan.
- Neon Free has 100 compute hours a month. Running out suspends the database until the next billing period, and exceeding 1 GB of storage blocks writes. So events are dispatched right after commit, with a cron sweep about every 15-30 minutes, and demo cleanup has to work.
- Neon Free has a 6-hour restore window, so scheduled `pg_dump` backups to R2 are needed for the restore rehearsal.
- Hyperdrive's read cache is not invalidated by writes, so caching stays off for this app.
- Hyperdrive pools in transaction mode, so transactions stay short and any `SET` runs inside each transaction.
- A managed database endpoint may be internet-reachable. PRD Section 6.3 now requires compensating controls and owner review for that case.
- Cost starts at $0 before AI usage or a domain, and becomes $5 a month if Workers Paid is needed. Neon's staging branches share the project's compute hours.

## Open proof items

Nothing here has been prototyped. These close at P0.2 with real evidence:

1. PDF text extraction fits within Workers CPU and memory limits, and normal requests fit the Workers Free 10 ms CPU limit.
2. The approval transaction works through Hyperdrive under concurrent requests.
3. Workspace isolation and least-privilege database roles work, including demo cleanup alongside append-only audit events.
4. Cron-triggered outbox dispatch survives failure and replay.
5. Database network exposure is understood and acceptable.
6. Backup and clean-room restore work.
7. Neon's wake-up delay on a first visit is acceptable.
8. Current official limits and prices are confirmed before accounts are created.

## Reversal

A failed proof item, or a change of mind by Jose, reopens this decision through an updated ADR. If Workers cannot do document extraction, consider moving only that job elsewhere before changing the whole stack.
