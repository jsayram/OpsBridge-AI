# Decision log

Short records of decisions made while building. Owner decisions live in `docs/MASTER_INBOX.md`, and the stack decision lives in `ADR/000-stack-and-hosting.md`. D-numbers here are routine engineering calls unless marked otherwise.

| ID | Date | Decision | Why | Reversal |
|---|---|---|---|---|
| D-001 | 2026-11-06 | Keep proofs in `spikes/p0.2/`, apart from app code | They are throwaway measurements, not a starting point | Delete the folder after P1 |
| D-002 | 2026-11-06 | Measure CPU two ways: V8 profiler and OS process time | The profiler adds about 2 ms and is noisy. Process time is the steadier upper bound | Replace both with Cloudflare's reported CPU time at P1.5 |
| D-003 | 2026-11-06 | Runtime role has no DELETE anywhere; a separate cleanup role purges | Reset and expiry never need destructive rights in the request path | None planned |
| D-004 | 2026-11-06 | Demo reset creates a new workspace and expires the old one | No delete on the request path, and reset costs the same as launch | Revisit if reset abuse grows storage |
| D-005 | 2026-11-06 | RLS on top of scoped queries | Defense in depth. A missed `WHERE` returns nothing rather than another visitor's data | Drop only if Hyperdrive testing shows it can't work |
| D-006 | 2026-11-06 | Purge function does not use `FOR UPDATE` | The first proof run failed: row locks need UPDATE privilege, which the cleanup role must not have. Expiry is one-way, so a plain read is safe | None |
| D-007 | 2026-11-06 | Google service account, not an owner OAuth token | It can only reach the one sheet shared with it. RS256 signing is cheap enough to do in the Worker | Owner refresh token if signing proves too slow in production |
| D-008 | 2026-11-06 | Biome for format and lint | One tool, one config, no plugin chain | Move to ESLint if a rule is missing |
| D-009 | 2026-11-06 | npm with a committed lockfile | Already installed, and pnpm would add a tool for no benefit here | None |
| D-010 | 2026-11-06 | ERP and CRM simulators live in the same Worker | PRD 2.7: fewest runtime services | Split if simulated faults ever affect app latency |
| D-011 | 2026-11-06 | Postgres 17 locally | Current Neon default range; recheck the major version when the project exists | Change the compose image |
