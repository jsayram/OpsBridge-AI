# Decision log

Short records of decisions made while building. Owner decisions live in `docs/MASTER_INBOX.md`, and the stack decision lives in `ADR/000-stack-and-hosting.md`. D-numbers here are routine engineering calls unless marked otherwise.

| ID | Date | Decision | Why | Reversal |
|---|---|---|---|---|
| D-001 | 2026-11-06 | Keep proofs in `spikes/p0.2/`, apart from app code | They are throwaway measurements, not a starting point | Delete the folder after P1 |
| D-002 | 2026-11-06 | Measure CPU two ways: V8 profiler and OS process time | The profiler adds about 2 ms and is noisy. Process time is the steadier upper bound | Replace both with Cloudflare's reported CPU time at P1.5 |
| D-003 | 2026-11-06 | Runtime role has no DELETE anywhere; a separate cleanup role purges | Reset and expiry never need destructive rights in the request path | None planned |
| D-004 | 2026-11-06 | Demo reset creates a new workspace and expires the old one | No delete on the request path, and reset costs the same as launch | Revisit if reset abuse grows storage |
| D-005 | 2026-11-06 | RLS on top of scoped queries | Defense in depth. A missed `WHERE` returns nothing rather than another visitor's data | Drop only if Hyperdrive testing shows it can't work |
| D-006 | 2026-11-06 | ~~Purge function does not use `FOR UPDATE`~~ Superseded by D-012 | The first proof run failed: row locks need UPDATE privilege, which the cleanup role lacked | D-012 |
| D-007 | 2026-11-06 | Google service account, not an owner OAuth token | It can only reach the one sheet shared with it. RS256 signing is cheap enough to do in the Worker | Owner refresh token if signing proves too slow in production |
| D-008 | 2026-11-06 | Biome for format and lint | One tool, one config, no plugin chain | Move to ESLint if a rule is missing |
| D-009 | 2026-11-06 | npm with a committed lockfile | Already installed, and pnpm would add a tool for no benefit here | None |
| D-010 | 2026-11-06 | ERP and CRM simulators live in the same Worker | PRD 2.7: fewest runtime services | Split if simulated faults ever affect app latency |
| D-012 | 2026-11-06 | Purge and workspace changes run in `SECURITY DEFINER` functions; cleanup role has no table rights; runtime role can't write `workspaces` | Independent review showed that table-level DELETE let cleanup reach owner rows, and UPDATE let a bug turn an owner workspace into a purgeable demo | None |
| D-013 | 2026-11-06 | One approval row per entry to Ready | Keeps the idempotency key simple and gives each decision its own record | None |
| D-011 | 2026-11-06 | Postgres 17 locally | Current Neon default range; recheck the major version when the project exists | Change the compose image |
| D-014 | 2026-11-06 | Keep raw parameterized SQL through `pg` for P1 and leave Drizzle out for now | P1 has a handful of queries and most logic sits in SQL functions, so a query layer would add a dependency with nothing to do. Drizzle stays approved | Add it at P2.1 if the table count makes typed queries worth it |
| D-015 | 2026-11-06 | Use `jose` for JWT verification rather than hand-written WebCrypto | Algorithm and claim handling is the wrong place for local cleverness. It is a small, free library with no dependencies | None |
| D-016 | 2026-11-06 | The local identity double supplies a public key to the real verifier, and has no code path of its own | A bypass flag would be one config mistake from production. Here a mistake gets a 404 | Removed when a real provider is verified, if it isn't useful for tests by then |
| D-017 | 2026-11-06 | Owner tokens are read from the Access header or the `CF_Authorization` cookie, and logout writes `sessions_valid_after` | Access sits in front of `/admin` paths only, so owner calls elsewhere need the cookie. Revocation is then server-side and audited | Header only, if Access later covers the whole API for the owner |
| D-018 | 2026-11-06 | Runtime role has no table rights on sessions, quota, users or memberships | Narrower than PRD 7.4 requires. A query bug can't read token hashes | None |
| D-019 | 2026-11-06 | One `launch_demo_session` call does quota, workspace, seed, session and audit | One round trip and one transaction, which matters on the 10 ms CPU budget | Split if a later phase needs a step in the Worker |
| D-020 | 2026-11-06 | Add a title-only `PATCH /cases/{id}` and read-only list and detail at P1 | The isolation matrix needs a real write path to test. Status moves stay in P2 | Replaced by the full route at P2.2 |
| D-021 | 2026-11-06 | Small History API router instead of a routing library | Eleven routes and one focus rule. No dependency needed | Adopt a router if nested data loading appears |
| D-022 | 2026-11-06 | Stay on TypeScript 5.9.3, advice only | Per the P1 brief's upgrade check: 7.x is available, but nothing here needs it, and a compiler major belongs in its own change | Review at P7 |
| D-023 | 2026-11-06 | Reset keeps the demo role and rotates the token, on the same session row | The visitor keeps their place in the story, and the old cookie dies at once | None |
| D-024 | 2026-11-06 | The owner workspace is seeded with synthetic rows, one owner workspace only | Lets "two guests plus owner" be tested before any real owner exists | None |
| D-025 | 2026-11-06 | Demo limits live in a migrator-owned table, not Worker variables | Independent review showed a Worker secret or a leaked app credential could stretch the 24-hour rule and the cap | None |
| D-026 | 2026-11-06 | Reset spends the launch budget, and IPv6 counts by /64 | Review showed one client could make 30 workspaces an hour against a purge of 10, filling the cap for everyone | Separate reset budget if real use shows families sharing an address get blocked |
| D-027 | 2026-11-06 | Own small JWKS cache rather than `createRemoteJWKSet` | jose's remote set shares a pending fetch between callers, which workerd's request-scoped I/O doesn't allow across requests, and a per-request set defeats its cache | Revisit if jose or workerd changes |
