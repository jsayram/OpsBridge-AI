# Test matrix

Layers from PRD 13.1. "Now" means a real check exists at P0. Everything else is planned, and the phase names where it first runs.

| Area | Layer | Key cases | First runs | Now |
|---|---|---|---|---|
| Case state machine | Unit | All legal moves, all illegal moves, reopen | P0.5 scaffold, P2.3 full | `tests/unit/case-status.test.ts` |
| Delivery label derivation | Unit | Every state and evidence pair | P0.5 scaffold, P4.4 full | `tests/unit/delivery-label.test.ts` |
| Approval atomicity | Integration | Race, injected failure, stale version | P2.4 | Spike P2.a to P2.e |
| Isolation | Integration + API | ID swap, no-context read, reused connection | P1.3 | Spike P3.a to P3.e |
| Roles and audit | Integration | Grants, guard trigger, purge limits | P2.1 | Spike P3.f to P3.u |
| Outbox | Integration | Crash replay, parallel claim, sweep | P4.2 | Spike P4.a to P4.e |
| Restore | Operational | Clean restore, guards survive | P2.5, P7.3 | Local half only |
| Sessions, CSRF, cookies | API security | Flags, Origin, fixation | P1.3 | No |
| Authorization matrix | API security | Every row in `PERMISSIONS-MATRIX.md` | P1.3, P2.2 | No |
| Reconciliation | Unit + integration | ID-first match, no fuzzy merge, replay | P3.4 | No |
| Sync faults | Contract | All PRD 8.4 faults | P3.6 | No |
| Sheet bridge | Integration | Check-before-append, formula guard, 403 dead letter | P4.3 | Simulated only |
| AI schema and citations | Unit + eval | Invalid output, adversarial suite | P5.2, P5.5 | No |
| Edits to suggestions | Unit | Field limits, revalidation | P5.4 | No |
| Reports | Integration | Totals agree, caps, CSV injection | P6.3 | No |
| Accessibility | E2E + manual | Keyboard, contrast, reduced motion | P1.4, P7.4 | Prototype contrast only |
| Secrets | CI | gitleaks canary | P0.5 | Yes |
| First visit | Hosted | Waking state, timing | P1.5 | No |

E2E-01 to E2E-28 and JOB-TEST-01 to JOB-TEST-08 stay in PRD 20 and 20.1. Each maps to a phase in its PRD row, and `docs/REQUIREMENTS-TRACEABILITY.md` tracks status as they get implemented.
