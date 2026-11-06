# OpsBridge AI

An enterprise operations command center for a fictional services business, built as an independent portfolio project. It covers CRM and ERP reconciliation, consultant case workflow, human-reviewed AI document extraction, Zapier automation and ROI analytics. All data is synthetic, and it isn't affiliated with any named vendor or employer.

**Status: foundation only.** The repository holds the design, proofs and a buildable skeleton. There is no working application yet, nothing is deployed, and no integration is connected. See `docs/PHASE-LEDGER.md` for real state.

## Prerequisites

Node 22 or newer, Docker, and gitleaks for the full local check.

## Run it

```bash
npm ci
npm run dev
```

The scaffold serves a placeholder page at `http://localhost:8787` and `/health/live`.

Local Postgres is only needed by the proofs in `spikes/` for now:

```bash
docker compose -f infra/docker-compose.yml up -d --wait
```

## Check it

```bash
npm run ci:local
```

That runs format, lint, types, unit tests, build, fixture checks, dependency audit and secret scan from a clean copy. `.github/workflows/ci.yml` runs the same steps, but it has never run on GitHub because no remote exists yet.

## Where things are

| Start here | For |
|---|---|
| `PRD.md` | The contract |
| `ARCHITECTURE.md` | Runtime, trust boundaries, data flows |
| `THREAT-MODEL.md`, `SECURITY.md` | Security design |
| `ADR/000-stack-and-hosting.md` | Stack decision and proof results |
| `docs/design/` | ERD, permissions, state machines, OpenAPI, contracts, costs |
| `docs/prototypes/` | Static UI prototypes |
| `docs/PHASE-LEDGER.md`, `docs/reports/` | What actually happened |

## Known limitations

Everything beyond health routes and two domain modules is design. Local runs skip Hyperdrive, so database behavior has not been proven through it.
