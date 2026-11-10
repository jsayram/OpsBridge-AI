# Start here

You have this repository and want to run, change, operate or hand on OpsBridge AI. This page sends you to the right document. Read `README.md` first if you don't know what the project is.

## What state it is in

- It runs on a local machine against Docker Postgres. **Nothing is deployed.** No Cloudflare, Neon, Google, Zapier, Salesforce or AI provider account exists yet.
- Phases P0 to P7 are accepted for limited scope by the coordinator, and P8 has run locally. No phase has the owner's own acceptance. `docs/PHASE-LEDGER.md` is the record.
- Live integrations are built and tested against labeled test doubles only.

## Pick your path

| You want to | Read | Time |
|---|---|---|
| Run the app and click through the demo | "Run it" below, then `docs/DEMO-SCRIPT.md` | 15 minutes |
| Change the code | `docs/ONBOARDING.md` | 1 hour to a first change |
| Operate the demo day to day | `docs/OPERATOR-GUIDE.md` | 20 minutes |
| Own it: accounts, costs, who can do what, how to shut it down | `docs/OWNERSHIP.md` | 15 minutes |
| Put it on the internet | `docs/LAUNCH-CHECKLIST.md`, then `docs/runbooks/HOSTED-SETUP.md` | An afternoon, after the accounts exist |
| Deal with something broken | `docs/runbooks/INCIDENT.md` | When it happens |
| Update, roll back, restore, rotate or revoke | `docs/runbooks/HANDOFF.md` | When it happens |
| Check a claim before repeating it | `docs/EVIDENCE-MATRIX.md` | 10 minutes |

## Run it

You need macOS or Linux, Node 22, Docker, and git. Use Node 22 even if a newer one is installed; CI uses 22.

```bash
git clone <repository URL> OpsBridge-AI
```

```bash
cd OpsBridge-AI
```

```bash
npm ci
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run db:up
```

```bash
npm run db:setup
```

```bash
npm run dev
```

Open `http://localhost:8787` and press **Launch Guided Demo**. The checklist on the **Guided demo** page walks you through five steps.

`npm run db:setup` is safe to run again. `.dev.vars` holds one local placeholder, not a secret. The database password in `infra/docker-compose.yml` is a throwaway local value. To stop the database:

```bash
docker compose -f infra/docker-compose.yml down
```

`/admin` answers 404 locally. That is deliberate: no identity provider is configured.

## Check it

```bash
npm run ci:local
```

This copies the repository to a temporary folder and runs everything CI runs, in order, on its own databases: format, lint, types, unit, integration on real Postgres, the query profile, build, bundle scan, fixture checks, the AI evaluation in fixture mode, Playwright in Chromium, the dependency audit and a secret scan. It needs `gitleaks` and the Playwright Chromium browser (`npx playwright install chromium`). It takes about ten minutes.

Run one test suite at a time. Each suite drops and recreates its own database in setup, so two suites at once break each other.

## Where things live

| Path | What |
|---|---|
| `backend/src` | The Worker: Hono routes, repositories, domain rules, jobs, integrations, AI gateway |
| `backend/migrations` | SQL migrations `0001` to `0011`, applied in order and never edited |
| `frontend/src` | The React app |
| `tests/` | `unit`, `integration`, `profile`, `eval` and `e2e` suites |
| `scripts/` | Database, CI, scans, smoke, rehearsal and fixture scripts |
| `infra/` | Docker Compose and the database role bootstrap |
| `docs/` | Plans, reports, runbooks, design notes, evidence |
| `PRD.md` | The requirements, version 1.4 |
| `DECISIONS.md`, `ADR/` | Every decision and the stack ADR |

## Rules that keep it honest

- Never put real personal, employer or business data in the app or the repository.
- Never commit a secret. `npm run scan:security` and the gitleaks step check for them.
- Don't describe a simulation as live, a fixture as AI output, or a projection as a measurement. The labels in the app are there for that reason.
- Accounts, money, deploys, pushes and merges into `main` are the owner's decisions. `docs/SESSION_HANDOFF.md` lists the stop points.
