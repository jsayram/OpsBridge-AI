# Requirements traceability

Updated 2026-11-06 at P0. Status words follow PRD 19.5. Nothing below is Owner Accepted, Merged or Deployed. "Designed" means a checked design artifact exists; it is not an implementation claim.

Each row points to the artifact that covers the requirement today. Later phases replace "Planned" with code paths, test names and run evidence.

## Job requirements (25 IDs)

Classification of every posting clause, from the four-page posting re-read on 2026-11-06:

- **Product** the app can show it.
- **Artifact** a document or process record shows it.
- **Real-experience** only Jose's actual history can show it, and the app must not imply otherwise.
- **Out of scope** not addressed on purpose.

| ID | Requirement | Class | P0 evidence | Status | Owning phases |
|---|---|---|---|---|---|
| JOB-01 | Shipping production apps or integrations | Product + Real-experience | Scaffold and proofs only | Planned | P1, P2, P7, P8 |
| JOB-02 | One modern language | Product | `backend/`, `frontend/` TypeScript scaffold | Scaffold verified locally | P0-P8 |
| JOB-03 | REST APIs, CRM/ERP, NetSuite a plus | Product; live NetSuite stays an experience gap | `docs/design/openapi.yaml`, `docs/design/INTEGRATION-CONTRACTS.md` | Designed | P0, P3, P7 |
| JOB-04 | Strong SQL and data modeling | Product | `docs/design/ERD.md`, `spikes/p0.2/sql/001_schema.sql`, `docs/evidence/P0.2/db-proofs-run2.json` | Designed; proof schema verified locally | P0, P2, P3, P6 |
| JOB-05 | Git, code review, agile | Artifact + Real-experience | Branch history, `docs/BACKLOG.md`, package reports | In use | P0-P8 |
| JOB-06 | Leading or mentoring developers | Real-experience | Engineering standards only; no people-leadership claim | Planned | P0, P7, P8 + interview |
| JOB-07 | AI tools in the dev workflow | Artifact | Package reports name AI work, review and checks | In use | Every package |
| JOB-08 | Communication for non-technical people | Artifact | `docs/BUSINESS-BRIEF.md`, teach-backs in package reports | Drafted | P0, P6, P8 |
| JOB-09 | Ambiguity, iterating quickly | Artifact | `DECISIONS.md`, P0.2 proofs that changed the design | In use | P0-P8 |
| JOB-10 | Internal tools for consultant workflows | Product | `docs/design/STATE-MACHINES.md`, cases prototype, journey map | Designed | P0, P2, P3 |
| JOB-11 | Connect an inventory platform | Product (synthetic, read-only) | `docs/design/INTEGRATION-CONTRACTS.md`, fixture plan | Designed | P0, P3, P6 |
| JOB-12 | Eliminate manual workflow and reporting | Product + Artifact | `docs/BUSINESS-BRIEF.md` before/after map (assumed baseline) | Designed | P0, P3, P4, P6 |
| JOB-13 | Pilot generative AI | Product (small synthetic pilot) | PRD 10 revisions, eval plan in `docs/design/FIXTURE-PLAN.md` | Designed | P5, P7 |
| JOB-14 | Documentation that outlives the author | Artifact | This repo's docs plus vault read-back | In use | Every package, P8 |
| JOB-15 | Priorities, sprints, coaching | Artifact + Real-experience | `docs/BACKLOG.md`; coaching stays real-experience | Started | P0-P8 |
| JOB-16 | Hiring and onboarding | Real-experience; illustrative artifacts only | None yet | Planned | P0, P8 + interview |
| JOB-17 | Partner with ops, finance, sales, consulting | Artifact (fictional stakeholders) | `STAKEHOLDER-BRIEF.md` | Drafted, labeled hypothetical | P0, P3, P6, P8 |
| JOB-18 | Test-and-learn, reuse across teams | Product + Artifact | Second-team rule planned in fixture plan | Designed | P0, P4, P7, P8 |
| JOB-19 | Pipelines into one trusted source | Product | `docs/design/INTEGRATION-CONTRACTS.md`, `DATA-DICTIONARY.md` | Designed | P2, P3, P7 |
| JOB-20 | Definition mismatches ("customer") | Product | `DATA-DICTIONARY.md`, reconciliation prototype | Designed | P0, P3, P6 |
| JOB-21 | Dashboards and self-serve reporting | Product | Overview prototype | Designed | P6, P7 |
| JOB-22 | ROI and business cases | Product + Artifact | `docs/BUSINESS-BRIEF.md` | Planned | P6, P8 |
| JOB-23 | Cloud and CI/CD | Product | `.github/workflows/ci.yml`, local CI logs in `docs/evidence/P0.5/` | Local only, no hosted run | P0, P1, P7, P8 |
| JOB-24 | Workflow/RPA tools | Product (Zapier) | Outbox and Mode A design | Designed | P4, P7 |
| JOB-25 | Startup or consulting background | Real-experience | Fictional context only | Planned | P0, P8 + interview |

### Posting clauses with no JOB row

| Clause | Class | Treatment |
|---|---|---|
| Player-coach, "leads from the keyboard" | Real-experience | Covered by JOB-05, JOB-06 and JOB-15 in interview. |
| Consultant workflow platform (named system) | Out of scope | A fictional queue only; no copy of an employer platform (PRD 8.6). |
| Reporting line, location, hours, 25 lb lift, pay, benefits, EEO, disclaimer | Out of scope | Employment terms, not product evidence. |
| AI agents (nice-to-have) | Out of scope for v1 | PRD 4.2 excludes autonomous agents; JOB-13 covers bounded LLM use. |
| Power BI, Tableau, Looker | Out of scope | React charts are custom BI and must not be described as these tools. |
| Azure, AWS | Out of scope | Cloudflare work is cloud evidence but never Azure or AWS evidence. |

No clause was left unclassified, and nothing above claims experience Jose has not supplied.

## P0 acceptance

| ID | Criterion | Evidence | State |
|---|---|---|---|
| P0-A | Every trust boundary and data flow explained with a diagram | `ARCHITECTURE.md`, `THREAT-MODEL.md` | Met |
| P0-B | Owner signs off on any charge before provisioning | `docs/design/COST-INVENTORY.md`, inbox DEC-002 and DEC-003; nothing provisioned | Met as a control; approvals pending |
| P0-C | CI runs on a clean scaffold and can fail meaningfully | `docs/evidence/P0.5/` local clean-copy runs and canary | **Partial:** no GitHub remote, so the workflow has never run on GitHub |
| P0-D | No TBD for security-critical behavior | `THREAT-MODEL.md` section "Open items", grep in `docs/reports/P0.6.md` | Met |
| P0-E | Report lists open decisions and deferred risks | `docs/reports/P0.md` | Met |

## ADR-000 proof items

See `ADR/000-stack-and-hosting.md` for the state of each item and `docs/reports/P0.2.md` for the evidence.

## Design decisions to requirements

| Decision | Requirement | PRD section | Later test |
|---|---|---|---|
| Check-before-append on the sheet | P4-E, E2E-05 | 9.2 | P4.2 crash and replay test |
| `dispatch_state` and `delivery_evidence` split | P4.4, E2E-16 | 7.2, 9.1 | P4.4 accepted-not-confirmed test |
| Cleanup role and retention log | ADR proof 3, 12.3 retention | 7.4 | P1.3, P7.2 |
| Guests pick fixtures only | E2E-13, P5.1 | 5.3, 8.2 | P5.1 guest upload denial |
| Shared template plus scenario pack | Section 16, P1.3 | 16.1 | P1.3 seed test |
| Text-layer abstention | 10.4 eval | 10.2, 10.4 | P5.5 messy category |
| Case reopen, exception Deferred, Accepted with Edits | P2.3, 8.5, 10.2 step 9 | 7.2 | P2.3, P3.4, P5.4 |
| Google credential inventory | 12.1, 17 | 12.1, 17 | P4.3 |
| First-visit target | GOAL-01, 13.2 | 13.2 | P1.5, P7.4 |
| After-commit dispatch, 30-minute sweep | 6.2, ADR consequences | 6.2, 17 | P4.2 |
