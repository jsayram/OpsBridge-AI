# OpsBridge AI

An enterprise operations command center for a fictional services business, built as an independent portfolio project. It covers CRM and ERP reconciliation, consultant case workflow, human-reviewed AI document extraction, Zapier automation and ROI analytics. All data is synthetic, and it isn't affiliated with any named vendor or employer.

**Status: local shell only.** A visitor can launch a private synthetic workspace, reset it and browse its cases on a local machine. The case workflow, integrations, automation, AI review and analytics don't exist yet. Nothing is deployed, owner sign-in has only met a test double, and no integration is connected. See `docs/PHASE-LEDGER.md` for real state.

## Prerequisites

Node 22 or newer, Docker, and gitleaks for the full local check.

## Run it

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:up
npm run db:setup
npm run dev
```

The app runs at `http://localhost:8787`. `npm run db:setup` is idempotent. The Docker database and its password are throwaway local values.

Owner paths under `/admin` answer 404 here, because no identity is configured. That is the intended safe default. Browser tests turn on a labeled local test double.

## Check it

```bash
npm run ci:local
```

That runs format, lint, types, unit tests, integration tests on real Postgres, build, client bundle scan, fixture checks, Playwright on real workerd, dependency audit and secret scan from a clean copy. It needs Docker and Playwright's Chromium (`npx playwright install chromium`). `.github/workflows/ci.yml` runs the same steps, but it has never run on GitHub because no remote exists yet.

## Where things are

| Start here | For |
|---|---|
| `PRD.md` | The contract |
| `ARCHITECTURE.md` | Runtime, trust boundaries, data flows |
| `THREAT-MODEL.md`, `SECURITY.md` | Security design |
| `ADR/000-stack-and-hosting.md` | Stack decision and proof results |
| `docs/design/` | ERD, permissions, state machines, OpenAPI, contracts, costs |
| `docs/prototypes/` | Static UI prototypes |
| `docs/ENVIRONMENTS.md`, `docs/runbooks/` | Environment reference, release, rollback, identity |
| `docs/PHASE-LEDGER.md`, `docs/reports/` | What actually happened |

## Known limitations

Case workflow, reconciliation, automation, AI review and analytics are still design. Local runs skip Hyperdrive, so database behavior has not been proven through it. Browser tests run in Chromium only.
