# OpsBridge AI session handoff

Updated: 2026-11-09 (America/New_York), end of the local P7 phase session.

## Objective and actual state

Build an honest, secure enterprise operations portfolio aligned to the Development & Automation Lead posting. Application implementation resumed on 2026-11-06 as phased sessions. P0 to P4 are coordinator accepted for limited scope. P5 and P6 are coordinator accepted for limited scope. P7 has run locally on `phase/p7-release-gate`, which is not pushed, and is waiting for coordinator review. A visitor can now attach one of 40 fictional documents to a case, get a labeled deterministic fixture review whose every field cites the page and text it came from, and as a manager accept, edit or reject it. Only an accept changes the case, through the ordinary version-checked checklist command. The owner's live AI path is built and tested against a labeled double and is Pending Owner Credentials: no provider account, key or budget exists. Under DEC-003 there is no hosted upload and the Worker never parses a PDF. P6 adds dashboards computed live from the records, each number labeled synthetic, measured, estimated or unknown; bounded reports with a formula-safe CSV export; an ROI calculator labeled as an illustrative projection; and a one-page executive business case whose figures a test holds to the calculator. Nothing is deployed. P7 checked the whole system locally: offline scans with canaries, a negative sweep over every API operation, every provider switched off in turn, real rollback and restore rehearsals, an incident runbook, Safari's engine and an iPhone-sized screen, and a small load profile. The outbox dispatcher now runs as its own database role (D-076), so hosting needs a third Hyperdrive config. `docs/reports/P7.md` ends with the list of what Jose must do before staging and before a public launch.

The source PRD is `OpsBridge_AI_Phased_PRD_v1.0.md`, unchanged. The maintained revision is `PRD.md` version 1.4, with an exact matching `OpsBridge_AI_Phased_PRD_v1.4.md` snapshot. The v1.1 and v1.2 snapshots are kept as history. The original source is preserved unchanged. A source document or scaffold plan is not a working app. No build phase is owner-accepted by this handoff.

## Current architecture decision

Jose chose the stack direction on 2026-11-06 (DEC-001, `ADR/000-stack-and-hosting.md`): React/TypeScript/Vite and a TypeScript API on one Cloudflare Worker, PostgreSQL through Hyperdrive, with Neon Free as the planned provider, starting on Workers Free. C#, Railway, Containers, D1, PlanetScale and Convex were rejected. Hono, Drizzle and Vitest are approved for local use. Private R2 storage and Cloudflare Access are proposals. DEC-002 now approves free Cloudflare and Neon accounts on `workers.dev`, which Jose creates himself. No session creates one. ADR-000 records each proof: local proofs passed; PDF extraction does not fit the Workers Free 10 ms limit, which DEC-003 holds; Hyperdrive and Neon items are pending credentials.

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

Standing deferral (DEC-008, 2026-11-06): a live-account acceptance criterion that cannot be met without an account, such as Salesforce, Google Sheets and Zapier, the AI provider, hosted Access, or Hyperdrive and Neon proofs, does not need a new question. Mark it Pending Owner Credentials/Configuration, build and test it against a labeled double, and keep going. Creating accounts and credentials is still a stop point.

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

`docs/reports/P7.md` is the current record, with `docs/reports/P6.md`, `docs/reports/P5.md`, `docs/reports/P4.md`, `P3.md`, `P2.md`, `P1.md` and `P0.md` before it. Nothing has run through Hyperdrive, Neon, R2, Sheets or Access, or on Cloudflare hardware, and no real Salesforce or NetSuite system has been contacted. Run local tools with Node 22 on the path: the default shell is Node 26, and CI uses 22. The master pushed `main` and `phase/p0-foundation` to a public repository and opened draft PR https://github.com/jsayram/OpsBridge-AI/pull/1, which must not be merged. DEC-003 to DEC-008 are answered; DEC-003 closed on 2026-11-09 as "Stay free, fixtures only". Automation operation, the Zapier demo steps and revocation are in `docs/runbooks/AUTOMATION.md`. Live AI settings and the provider data note are in `docs/ENVIRONMENTS.md` and `docs/design/AI-PROVIDER-DATA.md`. Every Vitest run loads `tests/setup/no-network.ts`, which refuses any outside host (D-069).

The repository root is this project folder. Docker volume `opsbridge_opsbridge-pgdata` holds only disposable local data, in databases `opsbridge` (spike), `opsbridge_dev`, `opsbridge_test`, `opsbridge_migrate_test`, `opsbridge_e2e`, `opsbridge_profile_test`, `opsbridge_restart_test`, the restore copies `*_restore`, `opsbridge_review` from the P4 review, and `opsbridge_eval_test` for the P5 evaluation (recreated on every `npm run eval:ai`), and from P7 `opsbridge_upgrade_test`, `opsbridge_rollback_test`, `opsbridge_rollback_test_recovered` and `opsbridge_load_test`. `npm run test:e2e:webkit` needs the Playwright WebKit browser (installed here) and serves https with wrangler's local certificate. `opsbridge_dev` may be behind; run `npm run db:setup` to bring it to `0011` and seed the fixture library and the 90-day snapshot history. Run one test suite at a time: each global setup drops and recreates its database, so two at once break each other. The `opsbridge-postgres` container is left running; `docker compose -f infra/docker-compose.yml down` stops it. No Worker is running.

## Exact restart steps

1. Read fresh `/Users/jramirez/Library/Application Support/CodexUsageMonitor/status.json`. Unknown/stale telemetry is not zero remaining. If a fresh signal requires handoff, finish the safe step and wait for Jose; do not schedule a continuation.
2. Read the master inbox, this handoff, maintained PRD, roadmap, job alignment, ledger, and relevant ADRs. Confirm source/mirror version and hashes; repair any documented sync gap through the official Obsidian CLI.
3. Inspect actual files and `git status` scoped to this project. Preserve other writers' changes and unrelated parent-repository content. Check for task-owned services before claiming none remain.
4. Check the current phase and branch in `docs/PHASE-LEDGER.md`. Hosted P1 follows `docs/runbooks/HOSTED-SETUP.md`. The next phase brief is `docs/briefs/P8.md`, which needs the P7 gate first and, for its hosted packages, the owner steps in `docs/reports/P7.md`. The metric definitions and report limits are in `docs/design/METRICS.md`. Connector operations and Salesforce setup are in `docs/runbooks/CONNECTORS.md`. Local recovery is in `docs/runbooks/RECOVERY.md`, incidents in `docs/runbooks/INCIDENT.md`, and the security checklist in `docs/SECURITY-CHECKLIST.md`.
5. When resumed, prepare the next bounded package brief with real branch/base identifiers, acceptance checks, ownership, dependencies, approvals and vault note path. Use `templates/work-package-brief.md`.
6. Execute only that authorized scope, collect real verification, update the package report/ledger/handoff/vault, and return the phase gate to Jose when due.
