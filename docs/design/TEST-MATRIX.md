# Test matrix

Layers from PRD 13.1. "Now" means a real check exists at the end of local P2. Everything else is planned, and the phase names where it first runs.

| Area | Layer | Key cases | First runs | Now |
|---|---|---|---|---|
| Case state machine | Unit | All legal moves, all illegal moves, reopen | P0.5 scaffold, P2.3 full | `tests/unit/case-status.test.ts`, `tests/unit/checklist.test.ts`, `tests/integration/workflow.test.ts` |
| Delivery label derivation | Unit | Every state and evidence pair | P0.5 scaffold, P4.4 full | `tests/unit/delivery-label.test.ts` |
| Approval atomicity | Integration | Race, injected failure, stale version | P2.4 | `tests/integration/approvals.test.ts`, canaries in `docs/evidence/P2.4/`. Local only, Hyperdrive repeat pending |
| Isolation | Integration + API | ID swap, no-context read, reused connection | P1.3 | `tests/integration/isolation-matrix.test.ts`, `roles-isolation.test.ts`, mutation canaries in `docs/evidence/P1.3/`. Local only, Hyperdrive repeat pending |
| Roles and audit | Integration | Grants, guard trigger, purge limits | P1.3 | P3 checks repeated on real migrations, `roles-isolation.test.ts`, `migrations.test.ts` |
| Outbox | Integration | Crash replay, parallel claim, sweep | P4.2 | Spike P4.a to P4.e |
| Restore | Operational | Clean restore, guards survive | P2.5, P7.3 | `scripts/restore-proof.sh` on real history, `scripts/restart-proof.mjs`, two-seed comparison in `migrations.test.ts`. Local only |
| Sessions, CSRF, cookies | API security | Flags, Origin, fixation | P1.3 | `tests/integration/sessions.test.ts`, `tests/e2e/shell.spec.ts` |
| Owner identity | API security | Wrong issuer, audience, expiry, signature, subject; `none` and HS256; logout | P1.2 | `tests/integration/owner-identity.test.ts`, test double only |
| Logs and bundle | Security | Redaction canary, client bundle scan | P1.4 | `shell-api.test.ts`, `scripts/check-bundle.mjs` |
| Authorization matrix | API security | Every row in `PERMISSIONS-MATRIX.md` | P1.3, P2.2 | Implemented rows only, `isolation-matrix.test.ts`, `cases-api.test.ts`, `workflow.test.ts`, `tests/unit/policy.test.ts` |
| Case queries | Integration + profile | ID swap, mass assignment, keyset walk, 1,000-case plans | P2.2, P2.5 | `tests/integration/cases-api.test.ts`, `tests/profile/query-profile.test.ts` |
| Schema | Integration | Composite keys, CHECKs, purge sweep over every table, write cap | P2.1 | `tests/integration/schema.test.ts` |
| Expiry races | Integration | Reset meeting purge | P2 | `tests/integration/expiry-race.test.ts` |
| Reconciliation | Unit + integration | ID-first match, no fuzzy merge, replay | P3.4 | No |
| Sync faults | Contract | All PRD 8.4 faults | P3.6 | No |
| Sheet bridge | Integration | Check-before-append, formula guard, 403 dead letter | P4.3 | Simulated only |
| AI schema and citations | Unit + eval | Invalid output, adversarial suite | P5.2, P5.5 | No |
| Edits to suggestions | Unit | Field limits, revalidation | P5.4 | No |
| Reports | Integration | Totals agree, caps, CSV injection | P6.3 | No |
| Accessibility | E2E + manual | Keyboard, contrast, reduced motion | P1.4, P7.4 | Axe, keyboard, reduced motion and phone viewport in Chromium, `tests/e2e/shell.spec.ts`. No Safari, no screen-reader run |
| Secrets | CI | gitleaks canary | P0.5 | Yes |
| Smoke | Deployment | Health, launch, reset, denial | P1.5 | `scripts/smoke.mjs`, local run only |
| First visit | Hosted | Waking state, timing | P1.5 | No |

E2E-01 to E2E-28 and JOB-TEST-01 to JOB-TEST-08 stay in PRD 20 and 20.1. Each maps to a phase in its PRD row, and `docs/REQUIREMENTS-TRACEABILITY.md` tracks status as they get implemented.
