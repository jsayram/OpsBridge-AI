# OpsBridge AI roadmap

Plan from PRD revision 1.1, current at PRD v1.3, November 6, 2026 (America/New_York). The build resumed on November 6 as phased sessions. `docs/PHASE-LEDGER.md` holds actual state, and these checkboxes are not status.

**9 macro phases, 47 bounded work packages, 9 owner acceptance gates.** PRD.md Section 14 owns full scope, dependencies, deliverables and verification. Every package is Planned; no implementation or acceptance is implied.

The coordinator reviews package evidence; Jose accepts macro phases. Default execution is sequential P0 through P8. Each implementation phase uses a fresh session and branch from the accepted head, with a bounded brief and shared master inbox. No sessions/branches are started by this planning update.

## P0

- [ ] P0.1 - Requirements and business process
- [ ] P0.2 - Stack, hosting, and ownership decision
- [ ] P0.3 - Security model and integration contracts
- [ ] P0.4 - Experience and deterministic fixture plan
- [ ] P0.5 - Local scaffold and CI baseline
- [ ] P0.6 - Foundation review and owner gate

## P1

- [ ] P1.1 - Environment and release controls
- [ ] P1.2 - Owner identity boundary
- [ ] P1.3 - Isolated guest workspaces
- [ ] P1.4 - Secure navigable shell
- [ ] P1.5 - Staging proof and owner gate

## P2

- [ ] P2.1 - Canonical schema and migrations
- [ ] P2.2 - Scoped case queries and edits
- [ ] P2.3 - Consultant workflow and handoffs
- [ ] P2.4 - Atomic approvals and audit events
- [ ] P2.5 - Reproducibility and core gate

## P3

- [ ] P3.1 - Source contracts and business definitions
- [ ] P3.2 - Simulated source ingestion
- [ ] P3.3 - Salesforce read-only test connection
- [ ] P3.4 - Evidence-led reconciliation
- [ ] P3.5 - Inventory and consultant integration slice
- [ ] P3.6 - Failure recovery and integration gate

## P4

- [ ] P4.1 - Rules and simulated effects
- [ ] P4.2 - Durable dispatch and safe retries
- [ ] P4.3 - Approved Google Sheets and Zapier bridge
- [ ] P4.4 - Delivery evidence and operator controls
- [ ] P4.5 - Automation failure and owner gate

## P5

- [ ] P5.1 - Private document lifecycle
- [ ] P5.2 - Structured fixture review
- [ ] P5.3 - Owner-only live gateway and budgets
- [ ] P5.4 - Human review and audited command
- [ ] P5.5 - Evaluation and AI owner gate

## P6

- [ ] P6.1 - Metric definitions and scoped queries
- [ ] P6.2 - Operational dashboards
- [ ] P6.3 - Self-serve reports and safe export
- [ ] P6.4 - ROI scenarios and sensitivity
- [ ] P6.5 - Executive business case and owner gate

## P7

- [ ] P7.1 - Security coverage and supply chain
- [ ] P7.2 - Abuse, resilience and recovery boundaries
- [ ] P7.3 - Restore, rollback and incident rehearsal
- [ ] P7.4 - Accessibility, browser and load verification
- [ ] P7.5 - Integrated release-risk owner gate

## P8

- [ ] P8.1 - Guided journey and demonstration proof
- [ ] P8.2 - Portfolio and interview evidence pack
- [ ] P8.3 - Maintainership, coaching and adoption handoff
- [ ] P8.4 - Authorized public launch
- [ ] P8.5 - Final ownership acceptance and archive

## Documentation at each step

Read the vault index/decisions before starting. At package finish and meaningful checkpoints, save the package note, changes, executed verification and failures, security/cost/migration/rollback implications, teach-back, open decisions and next restart step. Read notes back and update the PRD hash manifest. See docs/VAULT-WORKFLOW.md and PRD.md Section 19.

## Current next step

Owner review of PRD revision 1.1 and continued stack discussion. P0.2 records the hosting/runtime/database/OIDC/storage/budget decision before stack-specific scaffolding. App implementation resumes only after Jose explicitly asks.
