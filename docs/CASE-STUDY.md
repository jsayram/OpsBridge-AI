# OpsBridge AI: case study

**Status: draft for Jose's review. Not approved for publication.** Written 2026-11-09 from the evidence on `phase/p8-launch-prep`. Every claim carries a tag like [E3] that points to the evidence table at the end. If a sentence has no tag, it describes intent or design, not a result.

## The problem

A services company runs its work across a CRM, an ERP, an inventory system and spreadsheets. The same customer exists under different names in each. Cases move between consultants by email. Documents arrive as PDFs that someone retypes into a checklist. Reports get rebuilt by hand every month, and nobody can say which number is right.

OpsBridge AI is an independent portfolio project that works through that problem for a fictional company, Northstar Operations. It is a working application, not a mock-up, and it runs entirely on synthetic data.

## Who it is for

These are fictional personas. No real users, interviews or feedback are behind them.

| Persona | Needs |
|---|---|
| Operations analyst | One queue of cases with clear next steps, and conflicts between systems explained rather than hidden |
| Operations manager | To approve changes, see why a decision was made, and trust the dashboard numbers |
| Finance partner | Billing entities that match the CRM's idea of a customer, without silent merges |
| Engineering owner | To run, update, recover and shut down the system without its original developer |

## What it does

A visitor presses **Launch Guided Demo** and gets a private workspace with no sign-up [E1]. In about five steps they:

1. create a case, which records an audit event [E2];
2. run a simulated sync that finds a customer renamed in the ERP, shown with both source values and no automatic fix [E3];
3. attach a fictional document and get a review whose every field cites the page and text it came from, then accept, edit or reject it [E4];
4. approve a ready case, which writes audit history and records a Simulated automation run [E5];
5. read a recap, built from the workspace's own records, that separates what happened from what was simulated and what was measured, then reset [E6].

Behind those steps sit dashboards computed on request from the records with every number labeled synthetic, measured, estimated or unknown, bounded reports with a formula-safe CSV export, and an ROI calculator whose figures are labeled as illustrative projections [E7].

## Architecture

One Cloudflare Worker serves the React app and a Hono API from a single origin. PostgreSQL holds everything durable, through Hyperdrive in the planned hosted setup and directly in local development [E8]. The hosted half has not run yet [E15].

```
Browser (React SPA)
   | same-origin JSON, HttpOnly session cookie
   v
Cloudflare Worker (Hono API)
   auth, workspace scope, validation, audit
   CRM, ERP and inventory simulators
   outbox dispatcher (after commit + 30-minute sweep)
   AI gateway (fixture mode; owner-only live path)
   |
   v
PostgreSQL: row-level security, four least-privilege roles, append-only audit
```

## Decisions worth explaining

The project kept a decision log of 79 entries and one stack ADR [E9]. A few that shaped it:

- **TypeScript on Workers with Postgres, not a container stack.** One deployable, a free tier that fits a demo, and a relational database for the transactions an approval needs. The cost was a 10 ms CPU limit per request on the free plan, which ruled out parsing PDFs on the server [E10].
- **Fixtures instead of hosted upload.** When the PDF parsing proof failed the CPU limit, the owner chose to stay free: the 40 demo documents are pre-extracted at build time, and the Worker never parses a PDF [E10].
- **The database enforces isolation too.** Every query runs under row-level security keyed to the visitor's workspace, so an application bug alone can't leak another visitor's data. The outbox dispatcher got its own database role in the last hardening phase [E11].
- **Expand and contract migrations.** A rollback rehearsal caught that one migration would have broken the previous release. It was split so either version can run against the database during a rollout [E12].
- **Labels that can't overstate.** A delivery is Simulated, Queued, Accepted, Confirmed or Failed, and a provider's acceptance is never shown as confirmed delivery [E5].

## Security boundaries

- Visitors never sign in. A random session token lives in an HttpOnly, Secure, SameSite=Strict cookie, and the server stores only its hash [E1].
- Owner paths answer 404 unless an identity provider is configured. Owner sign-in is built against a test double; no provider is connected [E13].
- A spec-driven negative sweep calls every API operation as the wrong caller: nobody, a forged owner token, a cross-site page, another workspace's IDs, a viewer and hostile IDs [E11].
- Ten prompt-injection documents and twelve hostile model outputs changed nothing they shouldn't [E4].
- Offline scans found one High in a spike dependency, which was fixed. No critical or high issue is known to be open in the scoped local environment. All reviews so far were run by AI; no independent human review has happened [E14].

## Integration modes

| Integration | State |
|---|---|
| CRM, ERP and inventory | Simulators. The ERP follows NetSuite REST conventions and is not NetSuite [E3] |
| Salesforce (read-only) | Built and tested against a labeled double. Not connected [E13] |
| Google Sheet to Zapier | Built and tested against a labeled double. Not connected [E13] |
| AI provider | Built and tested against a labeled double, with budgets and a kill switch. Not connected; every review is a fixture [E4] |

## Test results

From the local clean-copy run on Node 22 at commit `69d75eb`, 2026-11-09 [E16]:

| Check | Result |
|---|---|
| Unit tests | 236 passed |
| Integration tests on real PostgreSQL | 417 passed |
| Browser tests on workerd, Chromium desktop and phone | 113 passed, 7 skipped by design |
| AI evaluation, fixture mode, 40 documents | All PRD thresholds met in fixture mode; one messy-document failure reported [E4] |
| Local load profile, 20 visitors for 60 seconds | No errors, worst route p95 475 ms [E17] |
| Restore and rollback | Rehearsed locally with two real Worker builds and a damage-and-restore drill [E12] |

## Limits

- Nothing is deployed. Every result above comes from a local machine [E15].
- No live CRM, ERP, Zapier, Google or AI provider has been connected [E13].
- Browser coverage is Chromium and Playwright's WebKit. Real Safari, a physical iPhone and a screen-reader pass by a person have not happened [E18].
- The AI evaluation measures the fixture pipeline, not a language model's accuracy [E4].
- ROI figures are projections from stated assumptions, not savings [E7].
- No real user has tried the demo. The five-minute target has been checked with an automated run only [E6].
- The project was built by one person working with AI coding tools. It shows how the work was planned, reviewed and documented, not experience managing a team.

## Roadmap

What would come next, in order: a staging deploy with the hosted rehearsals (restore, rollback, CPU per request, first-visit timing), a real-device and screen-reader pass, then optional live connections to a Salesforce Developer Edition org, a Google Sheet with a Zap, and an AI provider under a hard budget. Each one needs an owner account first [E19].

## Evidence

| Tag | Claim | Evidence in the repository |
|---|---|---|
| E1 | No-sign-up launch, isolated workspace, hardened cookie | `tests/e2e/shell.spec.ts` (P1-A, E2E-02), `tests/integration/sessions.test.ts`, `docs/reports/P1.md` |
| E2 | Case creation writes an audit event | `tests/e2e/core.spec.ts`, `tests/integration/cases-api.test.ts`, `docs/reports/P2.md` |
| E3 | Mismatch shown with both values, no automatic change; ERP is a simulator | `tests/e2e/integration.spec.ts`, `tests/integration/reconciliation.test.ts`, `docs/reports/P3.md` |
| E4 | Cited fixture review, human decision, injection resistance, evaluation | `tests/e2e/ai-review.spec.ts` (E2E-11 to E2E-14), `tests/integration/ai-review.test.ts`, `docs/evidence/P5.5/eval-report.md`, `docs/reports/P5.md` |
| E5 | Approval, audit, Simulated automation run, delivery labels | `tests/e2e/automation.spec.ts`, `tests/integration/dispatch.test.ts`, `docs/reports/P4.md` |
| E6 | Guided checklist, recap and reset read from records; timed automated run | `tests/e2e/guided-demo.spec.ts`, `tests/integration/demo-progress.test.ts`, `docs/reports/P8.1.md` |
| E7 | Labeled dashboards, safe CSV, illustrative ROI | `tests/e2e/analytics.spec.ts` (E2E-19, E2E-20), `tests/integration/analytics.test.ts`, `docs/reports/P6.md` |
| E8 | One Worker, one origin, Postgres | `ARCHITECTURE.md`, `wrangler.jsonc`, `ADR/000-stack-and-hosting.md` |
| E9 | Decision log and ADR | `DECISIONS.md` (D-001 to D-079), `ADR/000-stack-and-hosting.md` |
| E10 | CPU limit, failed PDF proof, fixtures-only decision | `ADR/000-stack-and-hosting.md` proof 1b, `docs/MASTER_INBOX.md` DEC-003 |
| E11 | Row-level security, roles, negative sweep | `tests/integration/release-negative.test.ts`, `tests/integration/roles-isolation.test.ts`, `docs/reports/P7.2.md`, D-076 |
| E12 | Expand and contract split, rollback and restore rehearsals | `scripts/rollback-rehearsal.mjs`, `scripts/restore-drill.mjs`, `docs/reports/P7.3.md` |
| E13 | Owner sign-in and live connectors on labeled doubles only | `tests/integration/owner-identity.test.ts`, `salesforce.test.ts`, `ai-gateway.test.ts`, `docs/reports/P3.md`, `P4.md`, `P5.md` |
| E14 | Scans, one High fixed, AI-run reviews only | `docs/reports/P7.1.md`, `SECURITY.md` |
| E15 | Nothing deployed | `docs/PHASE-LEDGER.md` (Deployed column) |
| E16 | Latest local CI results | `docs/reports/P8.md`, `docs/evidence/P8.5/` |
| E17 | Local load profile | `docs/evidence/P7.4/load-profile.txt`, `docs/reports/P7.4.md` |
| E18 | Browser coverage and what is pending | `docs/reports/P7.4.md`, `docs/reports/P8.1.md` |
| E19 | Owner steps before staging and launch | `docs/reports/P7.md` release-readiness list, `docs/LAUNCH-CHECKLIST.md` |

## Before publishing this

Jose reads and approves the text (P7 list item 14). Then check three things against the final evidence: the test numbers in the table match the latest run, nothing says "live", "deployed" or "in production" unless P8.4 has actually happened, and the limits section is still true.
