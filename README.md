# OpsBridge AI

OpsBridge AI is an independent portfolio app: an operations command center for Northstar Operations, a fictional services business. It connects CRM, ERP, inventory and case workflows in one place. It finds conflicts between those systems and routes each one to a person to resolve. It runs AI-assisted document review that a human approves, accepts with edits or rejects. Approved changes drive automations, and analytics show what happened, with ROI figures labeled as illustrative projections. All data is synthetic.

## What it demonstrates

- REST API design, CRM and ERP integration, and sync that survives replays, retries and partial failure.
- SQL data modeling in PostgreSQL: one canonical record set, source mappings, row-level security and least-privilege database roles.
- Data reconciliation that shows both source values as evidence and leaves the decision to a person.
- Workflow automation with a transactional outbox, typed rules, safe retries, a dead-letter state and operator controls.
- Applied AI with guardrails: every extracted field cites its source page and text, output is schema-validated, a human decides, and an evaluation suite measures the results.
- Executive analytics where every number has a written formula and a label (synthetic, measured, estimated or unknown), plus an ROI calculator built on stated assumptions.
- Delivery practice: ADRs, threat model, phased work packages, tests at every layer, local CI, recovery runbooks and rehearsed rollback.

## The guided demo

A visitor opens the app and clicks **Launch Guided Demo**. No sign-up is needed. The planned five-minute flow:

1. The server creates a private, isolated workspace from a fixed synthetic scenario.
2. The visitor creates a sample case and sees a durable activity event.
3. **Detect Mismatch** finds a conflict between a customer record and a simulated finance record, with both values shown.
4. The visitor reviews a fixture document. A labeled, deterministic review flags two missing fields and points to where it looked. The visitor accepts, edits or rejects the suggestion.
5. **Approve Resolution** updates the case, writes audit history, queues a simulated notification and updates analytics.
6. A recap lists what happened, what was simulated and what was measured. **Reset Demo** starts over.

Each step works today on its own screen. The single guided checklist with the recap is scheduled for P8.1.

## Architecture

One Cloudflare Worker serves the React app and the `/api` routes from a single HTTPS origin. PostgreSQL holds everything durable.

```
 Browser (React SPA)
        |  same-origin JSON, HttpOnly session cookie
        v
 Cloudflare Worker (Hono API /api/v1)
   - auth, workspace scope, validation, audit
   - CRM, ERP and inventory simulators
   - outbox dispatcher (after commit + cron sweep)
   - AI gateway (fixture mode; owner-only live path)
        |
        |  Hyperdrive (local: direct connection)
        v
 PostgreSQL (Neon planned; Docker locally)
   - row-level security, separate roles, append-only audit

 Off by default, owner-only: Salesforce, Google Sheet -> Zapier, AI provider
```

| Layer | Choice |
|---|---|
| Frontend | React, TypeScript and Vite, served as Worker static assets |
| API | TypeScript on Cloudflare Workers, using Hono |
| Database | PostgreSQL through Cloudflare Hyperdrive, with Neon Free as the planned host. Queries are raw parameterized SQL through `pg` with explicit SQL migrations. Drizzle is approved but has not been added (D-014, D-030 in `DECISIONS.md`) |
| Background work | Dispatch right after commit, plus a Cron Trigger sweep every 30 minutes for missed events and expired demo cleanup |
| Documents | Private R2 storage is planned for owner documents and backups. It is not wired up yet; the demo uses fixture documents that ship with the seed |
| Owner sign-in | Cloudflare Access (OIDC with MFA) is the proposed design |
| Tests | Vitest for unit, integration (real Postgres), query profile and AI evaluation; Playwright on real workerd in Chromium and WebKit |
| Local development | Postgres in Docker and `wrangler dev` |

The full picture, with trust boundaries and data flows, is in `ARCHITECTURE.md`. The stack decision and its proof results are in `ADR/000-stack-and-hosting.md`.

## Current status

The build runs in phases P0 to P8. `docs/PHASE-LEDGER.md` is the record of what is actually done.

| Phase | Scope | State |
|---|---|---|
| P0 | Foundation, design, stack proofs | Accepted for limited scope, locally |
| P1 | Shell, guest sessions, identity boundary | Accepted for limited scope, locally |
| P2 | Cases, workflow, approvals, audit | Accepted for limited scope, locally |
| P3 | Integrations and reconciliation | Accepted for limited scope, locally |
| P4 | Automation and Zapier bridge | Accepted for limited scope, locally |
| P5 | AI document review and evaluation | Accepted for limited scope, locally |
| P6 | Analytics, reports and ROI | Accepted for limited scope, locally |
| P7 | Security, recovery and release gate | Accepted for limited scope, locally |
| P8 | Guided demo polish, case study, public launch | Not started |

"Accepted for limited scope" means the coordinator reviewed the evidence and reran the local checks, with live-account items deferred. No phase has owner acceptance yet.

What that means in practice:

- **Nothing is deployed.** Everything runs on a local machine against Docker Postgres. Nothing has run through Hyperdrive, Neon, R2 or Cloudflare hardware.
- **Live connections are pending real accounts.** The Salesforce connector, the Google Sheets and Zapier bridge, the live AI gateway and owner sign-in are built and tested against labeled test doubles. No real org, sheet, Zap, AI provider or identity provider has been connected. The Hyperdrive and Neon proofs are pending for the same reason.
- **The ERP simulator is not NetSuite.** It follows documented NetSuite SuiteTalk REST conventions so the adapter, contract tests and retries have something realistic to work against. It is not a NetSuite integration.
- **AI results come from fixtures.** Every review a visitor sees is a labeled deterministic fixture. No language model has been called, and the 40-document evaluation reports fixture results, not live-model accuracy.
- **ROI figures are illustrative.** They are projections from stated assumptions over synthetic workload, not measured savings.
- **Browser coverage** is Chromium and Playwright WebKit, desktop and phone sizes. Real Safari, a physical iPhone and a VoiceOver pass have not been done.

## Running it locally

### Prerequisites

- Node 22 (the `engines` field allows 22 or newer; CI uses 22)
- Docker
- gitleaks, for the full local check
- Playwright browsers: `npx playwright install chromium`, plus `webkit` for the WebKit run

### Start the app

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:up
npm run db:setup
npm run dev
```

The app runs at `http://localhost:8787`. `npm run db:setup` is idempotent; it migrates the local database and seeds the fixture library and snapshot history. The Docker database and its password are throwaway local values. `docker compose -f infra/docker-compose.yml down` stops the database.

Owner paths under `/admin` return 404 locally because no identity provider is configured. That is the intended safe default. Browser tests switch on a labeled local test double.

### Check it

```bash
npm run ci:local
```

This runs, from a clean copy of the repository: format, lint, static checks, types, unit tests, integration tests on real Postgres, the query profile, build, the client bundle scan, fixture checks, the AI evaluation in fixture mode, Playwright, the dependency audit and a secret scan. `.github/workflows/ci.yml` runs the same steps, and it has passed on GitHub for the P0 and P1 pull requests.

Individual suites:

| Command | Runs |
|---|---|
| `npm test` | Unit tests |
| `npm run test:integration` | Integration tests on Docker Postgres |
| `npm run test:profile` | Query profile |
| `npm run eval:ai` | AI evaluation in fixture mode |
| `npm run test:e2e` | Playwright on workerd (Chromium) |
| `npm run test:e2e:webkit` | Playwright WebKit desktop and iPhone, served over local https |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Static checks |

Run one test suite at a time. Each suite's setup drops and recreates its own database, so two suites running at once break each other.

## Documentation

| File | What it covers |
|---|---|
| `PRD.md` | Product requirements and the phased plan |
| `ARCHITECTURE.md` | Runtime, trust boundaries, data flows, environments |
| `THREAT-MODEL.md`, `SECURITY.md` | Threats, controls and residual risks; security policy |
| `ADR/` | Architecture decisions, starting with the stack and hosting choice |
| `docs/ROADMAP.md` | Phases and work packages |
| `docs/PHASE-LEDGER.md` | What is planned, built, verified, accepted and deployed |
| `docs/reports/` | Phase and package reports with the evidence behind each result |

## Disclaimer

OpsBridge AI is an independent project. It is not affiliated with, sponsored by or endorsed by Salesforce, Oracle NetSuite, Zapier, Google, Cloudflare, Neon or any other company named here. Northstar Operations, its clients and every record in the app are fictional. Don't enter real personal or business information.
