# Final evidence matrix

Shipped, planned and pending, as of the P8 head on `phase/p8-launch-prep`, 2026-11-09 (America/New_York). Use this before repeating any claim about the project. "Met locally" means checked on Jose's machine against Docker Postgres and workerd; nothing has run on a host.

States used here:

- **Shipped (local):** built, tested, and running in the local app.
- **Built on a double:** code exists and is tested against a labeled test double; no real account is connected. Pending Owner Credentials under DEC-008.
- **Pending a host:** needs a deployed environment. Pending Owner Configuration under DEC-002.
- **Pending a person:** needs a human to run it.
- **Not built:** planned, no code.

## Capabilities

| Capability | State | Evidence |
|---|---|---|
| No-sign-up guided demo with checklist, recap and reset | Shipped (local) | `tests/e2e/guided-demo.spec.ts`, `tests/integration/demo-progress.test.ts`, `docs/reports/P8.1.md` |
| Isolated guest workspaces, quotas, reset, cron purge | Shipped (local) | `docs/reports/P1.md`, `tests/integration/sessions.test.ts` |
| Case workflow, checklists, handoffs, approvals, audit | Shipped (local) | `docs/reports/P2.md` |
| CRM, ERP and inventory simulators with sync and cursors | Shipped (local), simulated sources | `docs/reports/P3.md` |
| Reconciliation findings with both source values | Shipped (local) | `docs/reports/P3.md` |
| Salesforce read-only connector | Built on a double (P3-D) | `tests/integration/salesforce.test.ts` |
| Outbox dispatcher, retries, dead letter, delivery labels | Shipped (local) | `docs/reports/P4.md` |
| Google Sheet bridge to Zapier | Built on a double (P4-C) | `tests/integration/automation-operator.test.ts`, `docs/runbooks/AUTOMATION.md` |
| Fixture document review with citations and human decision | Shipped (local), fixture mode | `docs/reports/P5.md` |
| Live AI provider path with budgets | Built on a double (P5.3) | `tests/integration/ai-gateway.test.ts` |
| AI evaluation, 40 documents | Shipped (local), fixture results, not model accuracy | `docs/evidence/P5.5/eval-report.md` |
| Dashboards, reports, safe CSV, ROI calculator | Shipped (local); ROI illustrative | `docs/reports/P6.md` |
| Owner sign-in through Cloudflare Access | Built on a double | `tests/integration/owner-identity.test.ts`, `docs/runbooks/IDENTITY.md` |
| Public engineering evidence page | Shipped (local) | `/about/engineering`, `tests/e2e/guided-demo.spec.ts` (E2E-28) |
| Private R2 document storage and backups | Not built (DEC-003: fixtures only) | `docs/design/COST-INVENTORY.md` |
| Hosted upload and server-side PDF parsing | Not built by decision (DEC-003) | `ADR/000-stack-and-hosting.md` proof 1b |
| Staging and production deploys | Pending a host | `docs/LAUNCH-CHECKLIST.md` |

## Phase acceptance criteria

| Criteria | State |
|---|---|
| P0-A to P0-E | Met locally; P0-C partial (GitHub Actions ran for the P0 and P1 pull requests only) |
| P1-A to P1-D, P1-F | Met locally; P1-C on a double. **P1-E pending a host** |
| P2-A to P2-E | Met locally; hosted repeats pending a host |
| P3-A to P3-C, P3-E to P3-H | Met locally on simulated sources. **P3-D built on a double** |
| P4-A, P4-B, P4-D, P4-E | Met locally. **P4-C built on a double** |
| P5-A to P5-F | Met locally in fixture mode. **P5.3 live built on a double** |
| P6-A to P6-G | Met locally; P6-E without a screen-reader run (pending a person) |
| P7-A, P7-B, P7-E, P7-F | Met locally |
| P7-C | Met locally; hosted restore and rollback pending a host |
| P7-D | Met in Chromium and Playwright WebKit; real Safari, iPhone and VoiceOver pending a person |
| P8-A first-time interviewer finishes in five minutes without registration | No registration: met locally. The path runs end to end in an automated run. **A timed run by a real first-time visitor is pending a person** |
| P8-B doesn't depend on Jose's computer | **Pending a host**: today it runs only on his computer |
| P8-C public repo and case study match deployed behavior and CI | Case study drafted and traced to local evidence. **Deployed behavior pending a host; publication pending Jose** |
| P8-D owner can deploy, roll back, restore, rotate and update without the developer | Instructions written (`docs/runbooks/HANDOFF.md`, `START-HERE.md`); local steps rehearsed by an AI session. **Jose following them himself is pending** |
| P8-E demo survives missing Salesforce, Zapier and AI credentials, clearly labeled | Met locally: every step works with all providers off (P7-E, P8.1 fallback) |
| P8-F owner signs off release, links and monthly cost | **Pending Jose** (`docs/LAUNCH-CHECKLIST.md` section G) |
| P8-G onboarding, adoption guide, history and a truthful interview packet; simulated coaching not shown as experience | Documents written and labeled. The leadership packet's real examples must come from Jose (private vault note) |

## End-to-end scenarios

| Scenario | State | Evidence |
|---|---|---|
| E2E-01 guided demo, no signup | Met locally, four browser profiles | `guided-demo.spec.ts`, `shell.spec.ts` |
| E2E-02 to E2E-08, E2E-10, E2E-13, E2E-16 to E2E-21, E2E-26, E2E-27 | Met locally | `docs/reports/P7.5.md` table |
| E2E-09 CRM credentials revoked | Met on the double; real org pending (P3-D) | `salesforce.test.ts` |
| E2E-11 reject AI suggestion | Met locally, four browser profiles | `ai-review.spec.ts` |
| E2E-12 prompt injection | Met in fixture mode; live model pending | `ai-review.test.ts` |
| E2E-14 LLM unavailable or quota | Met on the double | `ai-gateway.test.ts` |
| E2E-15 Zapier destination unavailable | Met on the Sheets double; real Zap pending (P4-C) | `provider-outages.test.ts` |
| E2E-22 owner credential rotation | Partly, on the double; real rotation pending | `salesforce.test.ts` |
| E2E-23 staging restore | Local drill passed; staging pending a host | `scripts/restore-drill.mjs` |
| E2E-24 deployment rollback | Local rehearsal passed; hosted pending a host | `scripts/rollback-rehearsal.mjs` |
| E2E-25 Chrome, Safari, mobile, keyboard | Chromium and Playwright WebKit; real devices and VoiceOver pending a person | `docs/reports/P7.4.md`, `docs/reports/P8.1.md` |
| E2E-28 public engineering evidence | **Met locally (new in P8)**: no session, no API call, test results and limits, no admin data | `guided-demo.spec.ts` |

## Claims that must not be made

Until the matching row above changes state with evidence:

- "Deployed", "live", "in production", or a public URL.
- "Integrates with Salesforce", "NetSuite", "Zapier" or "Google Sheets" as working connections.
- "AI-powered" without saying the demo uses fixtures; any model accuracy figure.
- Any adoption, user, customer or savings figure.
- Any certification, compliance badge or independent security review.
- That Jose managed or hired a team because of this project.

## Open issues carried forward

| Issue | Severity | State |
|---|---|---|
| Demo capacity burst can refuse new visitors for hours | Medium, availability | Decide after the Workers CPU measurement |
| One render error on the case search on a Pixel 7 profile, once in three full Chromium runs | Unknown, intermittent | Not reproduced in 240 later runs; recorded in `docs/reports/P8.1.md` |
| WebKit "New case" miss | Was intermittent | Cause found and fixed in P8.1 (layout shift); confirm in real Safari |
| `TOKEN_ENCRYPTION_KEY` has no in-place rotation | Low | Documented workaround |
| No independent human review | Process gap | Recommended before public launch |
