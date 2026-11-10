# OpsBridge AI documentation workflow

Planning revision: 2026-11-05 (America/New_York). The build resumed on 2026-11-06 as phased sessions. This workflow does not mark any build phase accepted.

## Source of truth and audience

`PRD.md` in this project is the maintained requirements contract. The supplied `OpsBridge_AI_Phased_PRD_v1.0.md` is preserved unchanged; versioned revision files are snapshots. Code, contracts, migrations, tests, ADRs, and reproducible evidence belong in the project repository. `docs/ROADMAP.md` describes the current package plan; `docs/PHASE-LEDGER.md` records actual state.

The vault is Jose's readable project memory: what a package does, why it matters, decisions, verified results, lessons, approvals, and the exact next step. It contains a verified full PRD mirror, not a separately edited specification. A short narrative never substitutes for implementation evidence. Do not store private chain-of-thought; record concise decision rationale and observable work.

Vault content is private planning material. Do not publish the vault, the original job PDF, private career source notes, personal contact details, or vault filesystem paths as public application evidence. Public case-study material must be separately curated and redacted.

## Exact vault layout

Use the official Obsidian CLI with `vault="Jose-Ramirez-Vault"`. The root is `Projects/OpsBridge AI/`:

| Vault-relative note | Purpose | Project source where applicable |
|---|---|---|
| `OpsBridge AI.md` | Hub: current phase/package, implementation pause, next action, links | Project status and this workflow |
| `PRD.md` | Exact full Markdown mirror of the maintained PRD | `PRD.md` |
| `Sync Manifest.md` | PRD version, byte count, SHA-256, sync/read-back time and outcome | Current PRD and read-back comparison |
| `Roadmap.md` | Nine phases and their bounded packages | `docs/ROADMAP.md` |
| `Job alignment.md` | Job requirement-to-proof matrix and honest limits | `docs/JOB-ALIGNMENT.md` |
| `Decision log.md` | Decisions, options, owner words, effect, reversal criteria | ADRs and `docs/MASTER_INBOX.md` |
| `Session log.md` | Append-only meaningful checkpoints, with package links | Package reports and handoffs |
| `Phase ledger.md` | Actual progress and gate state | `docs/PHASE-LEDGER.md` |
| `Master inbox.md` | Owner questions, recommendations, answers and scope | `docs/MASTER_INBOX.md` |
| `Handoff.md` | Cold-start context, open risks, exact restart steps | `docs/SESSION_HANDOFF.md` |
| `Documentation workflow.md` | This workflow | `docs/VAULT-WORKFLOW.md` |
| `Templates/work-package-brief.md` | Package scope/verification brief | `templates/work-package-brief.md` |
| `Templates/work-package-report.md` | Package results and learning record | `templates/work-package-report.md` |
| `Templates/phase-review.md` | Owner gate/evidence review | `templates/phase-review.md` |
| `Phases/P0.md` through `Phases/P8.md` | One phase overview with gate, package links, review outcome | PRD phase section and phase report |
| `Phases/Px/Px.y - <short title>.md` | One package brief, checkpoints, report and review record | `docs/briefs/Px.y.md`, `docs/reports/Px.y.md` |

Substitute a real assigned ID and descriptive title for `Px.y`. Keep IDs stable. Create package notes when a brief is prepared, rather than filling the vault with empty notes. Use Obsidian links for wayfinding. No duplicate competing hub or alternate PRD is created.

## When documentation is required

1. Before a package: read the master inbox, handoff, current PRD/ADR, ledger, and relevant source; record the bounded goal, prerequisites, non-goals, acceptance checks, writer ownership, and stop points.
2. At meaningful checkpoints: append a dated entry after an architecture decision, material implementation result, failed verification, risk/scope change, owner answer, or interrupted session. Batch routine tool activity; do not transcribe every command or create model turns just for logging.
3. At every package end: write the package report and checkpoint note, update requirement coverage and ledger, and save exact next steps. Record a failed or blocked package just as carefully as a successful one.
4. Before moving to another package: the coordinator reviews the diff/evidence, checks required vault read-back, and records whether the package is ready. This does not accept its macro phase.
5. At each macro-phase boundary: compile the phase review, reconcile the job/requirements matrix, update handoff/inbox/ledger, and ask Jose to accept or revise. Wait for his answer before the next macro phase.
6. On quota handoff or session end: finish the safe step, update project/vault handoff and task-owned service state, and leave the exact restart instruction. Resume is manual; do not schedule inference continuations.

Record event times with timezone (America/New_York for Jose-facing notes); UTC is appropriate for machine evidence. Preserve original evidence timestamps.

## Required checkpoint contents

Each checkpoint is concise but enough to resume without guessing:

```markdown
### YYYY-MM-DD HH:mm America/New_York — Px.y — checkpoint title

- Goal and business reason:
- Plain-language concept and what Jose should understand:
- What changed and why (concise rationale):
- Files/contracts/migrations affected:
- Verification actually run: exact safe command or CI link, environment, result, timestamp, evidence path.
- Not run / failed / simulated / pending credentials:
- Security, privacy, accessibility, integration and cost implications:
- Decisions and owner approval reference (quote actual answer when relevant):
- Learning points: what the result demonstrates and how to reproduce it:
- Open risks or questions:
- Current state: planned / implemented / verified / accepted / merged / deployed recorded separately.
- Next exact action and prerequisite:
```

Use `templates/work-package-brief.md`, `templates/work-package-report.md`, and `templates/phase-review.md` for fuller records. Never claim tests passed from code inspection or another agent's report alone. Keep test logs sanitized and link durable artifacts with the revision/commit they concern.

## Decision and evidence rules

- Every proposal has an owner, affected package, options, recommendation, consequence, and decision needed by date/gate. Stack/provider proposals remain proposals until Jose answers.
- Only an actual owner answer can set `accepted`; quote it and record its scope. A package review is a coordinator finding. Neither implies permission to merge, push, provision, send messages, spend, or publish.
- Record `planned`, `implemented`, `verified`, `accepted`, `merged`, and `deployed` independently. A checked planning document does not mean its feature exists. A deployed change can still lack owner acceptance.
- Integration mode and delivery evidence use the PRD's exact truthfulness labels. Simulated ERP is never live NetSuite. Provider acceptance is never confirmed email delivery. Estimated ROI is never measured savings.
- Keep immutable failed results and superseding corrections; do not rewrite history to hide a failure. Revoked approval and superseded decisions need explicit entries.
- Resolve contradictory repo/vault state before continuing dependent work. Prefer current repository facts for what code does and owner records for what was approved. Never infer acceptance from an empty inbox.

## PRD synchronization and read-back

The coordinator performs these steps after every maintained PRD revision:

1. Finalize `PRD.md` and the matching versioned snapshot; compare them for exact equality. Record the source SHA-256 and byte count using a local hashing tool.
2. Discover the vault through `obsidian vaults verbose`; search/read the exact destination before changing it. Read `obsidian help create` and relevant command help before unfamiliar writes.
3. Create the full mirror through the official CLI. Updating this project-owned mirror is authorized by Jose's request to maintain the PRD in the vault; use exact-path overwrite only after reading and confirming that destination is the existing mirror. Preserve unrelated notes and concurrent edits.
4. Read the mirror back through the CLI. Compare the returned Markdown body with `PRD.md` byte-for-byte after removing only a demonstrable CLI transport newline or framing, never by normalizing substantive whitespace or content. If exact comparison is not possible, record the limitation and verify the saved note bytes read-only; never call an unchecked mirror synchronized.
5. Write `Sync Manifest.md` separately so `PRD.md` remains an exact mirror. Include source project path, PRD version, source hash/bytes, read-back hash/bytes, verifier, local/UTC time, and result. Update the hub's current version link.
6. Read the manifest and hub back, confirm note links and exact version/hash, and record the synchronization result in the session log and package/phase report.

For every other mirrored planning note and template, preserve the mapping above and independently verify the entire content with a source/read-back hash. The separate `Sync Manifest.md` records a row per file, not only the PRD: source path/version, destination note, source/read-back SHA-256 and byte count, sync time, and `Verified` or `Pending/Failed` outcome. `docs/DOCUMENT-SYNC.md` stores the project-side synchronization inventory. Only the coordinator performing a successful read-back may mark either manifest verified. Generated hub/decision/session/phase notes use source-section references and their own read-back result, rather than pretending to be exact file mirrors. Do not compute a hash before the final edit and leave it marked current afterward.

## Failures, interruptions and conflicts

If Obsidian is not running, launch it and retry. If the CLI cannot reach the vault or write permission is unavailable, keep the complete project documents, record `Vault sync pending` with the exact failed operation and recovery step, and report the limitation. Retry safely with the exact destination; inspect before creating any replacement note. Do not silently switch to raw filesystem writes, another vault, or duplicate notes.

A failed mirror read-back blocks the documentation-complete gate; independent local planning may continue while the sync is repaired. Do not declare a macro phase ready for acceptance with an unreported required documentation gap. After concurrent edits, stop dependent synchronization, read both versions, preserve the other writer's work, and reconcile through the coordinator.

## Privacy and cleanup

All business samples are synthetic. Never copy employer/customer records, immigration identifiers, private source dossiers, credentials, tokens, hook URLs, raw document payloads, or secret-bearing command lines into notes. Record secret variable names and approved setup instructions only. Redact screenshots and logs before saving them; vault privacy does not make a secret safe to store.

Use append-only session/decision entries and reversible note operations. Do not delete unrelated notes, change vault plugins/settings, or introduce an automated polling/model workflow as part of documenting this project.
