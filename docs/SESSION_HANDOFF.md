# OpsBridge AI session handoff

Updated: 2026-11-06 (America/New_York), end of P0 phase session.

## Objective and actual state

Build an honest, secure enterprise operations portfolio aligned to the Development & Automation Lead posting. Application implementation resumed on 2026-11-06 as phased sessions. P0 has run on local branch `phase/p0-foundation` and is waiting for coordinator review. A skeleton, proofs and design exist; there is no working application.

The source PRD is `OpsBridge_AI_Phased_PRD_v1.0.md`, unchanged. The maintained revision is `PRD.md` version 1.3, with an exact matching `OpsBridge_AI_Phased_PRD_v1.3.md` snapshot. The v1.1 and v1.2 snapshots are kept as history. The original source is preserved unchanged. A source document or scaffold plan is not a working app. No build phase is owner-accepted by this handoff.

## Current architecture decision

Jose chose the stack direction on 2026-11-06 (DEC-001, `ADR/000-stack-and-hosting.md`): React/TypeScript/Vite and a TypeScript API on one Cloudflare Worker, PostgreSQL through Hyperdrive, with Neon Free as the planned provider, starting on Workers Free. C#, Railway, Containers, D1, PlanetScale and Convex were rejected. Hono, Drizzle and Vitest are approved for local use. Private R2 storage and Cloudflare Access are proposals. No account, provisioning, spending, deployment or publication is approved. ADR-000 records each proof: local proofs passed; PDF extraction does not fit the Workers Free 10 ms limit, which DEC-003 holds; Hyperdrive and Neon items are pending credentials.

## Build status and how to run it

The build resumed on 2026-11-06. Master thread: `local_2ce00b84-dd6c-4a69-9efd-3a293bde5688`. Jose's words are in `docs/MASTER_INBOX.md`. Accept phases on checked evidence: the master records "coordinator accepted under delegation" in the ledger, and the Owner Accepted field stays empty unless Jose accepts himself.

Each phase session works in the shared checkout on its own local branch `phase/pN-<slug>`, cut from the previous accepted head. Phase branches stack, and nothing merges into `main` until Jose approves. Develop locally with Docker Postgres and `wrangler dev`. Keep building whatever does not depend on a blocked item. Keep work on hosted or live parts behind labeled simulations, and mark the criterion Pending Owner Credentials/Configuration.

Approved for local use: `psql` via Homebrew, Hono, Drizzle, Vitest, Playwright, React, Vite and Wrangler. Other free open-source development libraries are routine: record them in the package report.

**Stop points, always back to Jose through the master:**

- Creating or logging into any account, or any credential or secret value.
- Anything paid or hosted, domains, provisioning, deploys and staging exposure.
- Creating the GitHub repository, any push, and any merge into `main`.
- External sends and live third-party connections.
- Real personal, employer or business data.
- Permanent deletion of data or history.
- A PRD 12.4 security release blocker, a failed ADR-000 proof item, or a material scope change.

Everything else is routine. Do not stop for it.

## How phases run

P0 Foundation; P1 Hosted shell/identity; P2 Core records/audit; P3 Integrations/reconciliation; P4 Automation/Zapier; P5 AI review; P6 Analytics; P7 Release hardening; P8 Demo/launch/handoff. `PRD.md` and `docs/ROADMAP.md` own the bounded package IDs and prerequisites. The master coordinates phase briefs, actual evidence review, owner questions, and continuity. A fresh implementation phase session owns one approved phase on its own branch from the latest accepted head; only one writer owns a file set at a time. Bounded subagents may research/review or implement disjoint assigned files. They cannot accept their own work or authorize paid/external actions.

Read `docs/MASTER_INBOX.md` first on return. Route required owner questions there with options and a recommendation; bring them back through the master. Routine choices within the accepted package stay with the assigned implementer. Each package gets a report and verified vault checkpoint. Jose accepts or revises each macro phase; acceptance does not automatically authorize merge, push, hosting, spend, or release.

## Approval and stop points

- Existing user authorization covers this planning revision and project-vault documentation. It does not resume application implementation.
- Obtain the actual provider account, cost budget, domain/ownership and integration decisions before dependent provisioning.
- No account creation, recurring cost, external write integration, real outbound message, public deployment, merge, or push without applicable owner authorization. Preserve previously granted approvals and their scope; do not ask again without a material change.
- Never ingest employer or real sensitive business data. Never weaken security or claim simulated/live/verified states without evidence.
- If a package reaches a phase boundary or an unresolved security-critical choice, finish the safe step, document it, and return to the coordinator/Jose.

## Continuity files

- `docs/MASTER_INBOX.md`: decisions/questions and actual answers.
- `docs/PHASE-LEDGER.md`: planned vs implemented vs verified vs accepted vs merged vs deployed.
- `docs/VAULT-WORKFLOW.md`: exact note paths and read-back rules.
- `docs/JOB-ALIGNMENT.md`: job expectations and truthful proof requirements.
- `templates/`: package brief/report and phase-review templates.
- Vault: `Jose-Ramirez-Vault`, `Projects/OpsBridge AI/OpsBridge AI.md` hub and `Projects/OpsBridge AI/PRD.md` exact mirror. Check `Sync Manifest.md` before calling a mirror current.

## Actual verification and unresolved findings

`docs/reports/P0.md` is the current record. In short: local proofs passed for approval concurrency, isolation, roles, audit cleanup, outbox replay and restore (31 checks, `docs/evidence/P0.2/`). The scaffold passes all checks from a clean copy on Node 22 and 26, and a deliberate failing canary and a secret canary both failed as they should (`docs/evidence/P0.5/`). GitHub Actions has never run because no remote exists, so P0-C is partial. Nothing has run through Hyperdrive, Neon, R2, Sheets, Access or on Cloudflare hardware. Open decisions: DEC-002, DEC-003, DEC-004.

The repository root is this project folder; it no longer inherits `/Users/jramirez/Git`. Docker volume `opsbridge_opsbridge-pgdata` holds only disposable proof data. No services are running.

## Exact restart steps

1. Read fresh `/Users/jramirez/Library/Application Support/CodexUsageMonitor/status.json`. Unknown/stale telemetry is not zero remaining. If a fresh signal requires handoff, finish the safe step and wait for Jose; do not schedule a continuation.
2. Read the master inbox, this handoff, maintained PRD, roadmap, job alignment, ledger, and relevant ADRs. Confirm source/mirror version and hashes; repair any documented sync gap through the official Obsidian CLI.
3. Inspect actual files and `git status` scoped to this project. Preserve other writers' changes and unrelated parent-repository content. Check for task-owned services before claiming none remain.
4. Check the current phase and branch in `docs/PHASE-LEDGER.md`. The next brief is `docs/briefs/P1.md`.
5. When resumed, prepare the next bounded package brief with real branch/base identifiers, acceptance checks, ownership, dependencies, approvals and vault note path. Use `templates/work-package-brief.md`.
6. Execute only that authorized scope, collect real verification, update the package report/ledger/handoff/vault, and return the phase gate to Jose when due.
