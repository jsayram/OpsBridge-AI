# Px.y — Package brief

Status: planned. Prepared at: `<timestamp and timezone>`. Parent phase: `Px`. PRD version/hash: `<verified source>`. Owner: `<assigned phase session>`. Coordinator: `<master thread>`.

## Goal and business reason

Explain what changes for the fictional operator/interviewer and which JOB/GOAL/acceptance IDs it proves. Include a short plain-language explanation of the relevant concept so Jose can follow the work.

## Scope and prerequisites

- In scope:
- Explicit non-goals:
- Accepted predecessor phase/package and contract versions:
- Current actual repository root, branch/base commit and intended package branch:
- Files/directories this writer owns; other writers and read-only interfaces:
- Necessary tools/dependencies and already-authorized account/cost scope:
- Stack decision/ADR dependencies:

Do not invent a branch/base or treat placeholder text as an executable instruction. Resolve the repository boundary before creating the implementation branch.

## Deliverables and verification plan

| Requirement | Deliverable/file | Check and expected outcome | Evidence destination |
|---|---|---|---|
| `<ID>` | `<specific artifact>` | `<bounded executable/manual check>` | `docs/evidence/Px.y/` |

Include relevant negative/security cases, migration/recovery implications, accessibility and cost limits. Distinguish local checks, provider tests and hosted checks; unavailable credentials leave a named pending criterion.

## Routing rule

Anything that needs Jose's approval or an answer goes in the master inbox (`docs/MASTER_INBOX.md`), with the decision, the options and your recommendation, then stop and tell Jose it's there. Routine decisions are yours. Copy this rule into any brief you write.

## Stop points

Stop at the package's scope boundary or macro-phase gate; unresolved security-critical choices; changed stack/provider commitments; account/credential access; cost-bearing resources; external writes/messages; destructive operations; merge/push/deploy/publication lacking applicable owner authorization. Preserve existing approvals and do not ask again without a material scope change. Real employer/sensitive business data remains outside the project.

## Documentation and exit

Read `docs/SESSION_HANDOFF.md`, `docs/MASTER_INBOX.md`, current PRD/ADRs and ledger first. Create/read the package vault note at `Projects/OpsBridge AI/Phases/Px/Px.y - <short title>.md`. Log start, meaningful decisions/failures, and package end. Produce `docs/reports/Px.y.md`, update traceability/ledger/handoff, synchronize required notes through Obsidian CLI and verify read-back. The coordinator checks evidence before the next package. Jose accepts the macro phase separately.
