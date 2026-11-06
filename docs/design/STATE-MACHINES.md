# State machines

Transitions not listed here return `409 invalid_transition`. Every transition writes an audit event in the same transaction. Roles are defined in `PERMISSIONS-MATRIX.md`.

## Case

| From | To | Who | Prerequisite | Event |
|---|---|---|---|---|
| (new) | Draft | analyst | | |
| Draft | Intake | analyst | Customer linked | case.created |
| Intake | Needs Review | analyst | Required checklist items answered or flagged | case.needs_review |
| Needs Review | Ready | reviewer | No open required checklist item. Creates a new pending approval in the same transaction | |
| Ready | Needs Review | reviewer, by PATCH or by rejecting the approval | Reason required | case.needs_review |
| Ready | Approved | reviewer, approval command only | Pending approval decided, version matches | approval.completed |
| Approved | Closed | reviewer | | |
| Closed | Needs Review | reviewer, `POST /cases/{id}/reopen` | Reason required, version matches | case.needs_review, payload reason `reopened` |

`POST /cases` creates a case in Intake in one transaction, which is the Draft to Intake step and its `case.created` event. `draft: true` stops at Draft, with no event until the case moves on.

**Checklist states:** `open`, `flagged`, `done`, `not_applicable`. Leaving Intake needs every required item answered or flagged, so a flagged item can reach a reviewer. Entering Ready needs every required item `done` or `not_applicable`. The checklist and the case details lock at Ready, so what a reviewer approves stays what was approved, and a return to Needs Review unlocks them (`409 case_locked`). A checklist edit bumps the case version, so a page from before the edit is stale. Failures return `409 checklist_incomplete` or `409 checklist_locked`.

**Approval statuses:** `pending`, `approved`, `rejected`, `withdrawn`. A PATCH return from Ready withdraws the pending row. Every workflow command takes the case row lock first, so prerequisites can't change between the check and the update.

**Handoff:** any non-closed case, to one person or one queue. An outstanding checklist item does not block it; the history records how many were open.

Reopen reuses `case.needs_review`, so the five-event allowlist in PRD 9.1 does not grow. A reopened or returned case gets a new approval row each time it enters Ready, and the idempotency key uses that row's ID, so a later approval is a new business event and not a duplicate. PATCH can never reach Approved, and only the reopen endpoint leaves Closed.

## Exception (reconciliation finding)

| From | To | Who | Note |
|---|---|---|---|
| (detected) | Open | system | Replay of the same source snapshot does not reopen or duplicate |
| Open | Investigating | analyst, `POST /advance` | |
| Investigating | Proposed | analyst, `POST /advance` | Proposed resolution recorded |
| Proposed | Resolved | reviewer, Approve | Applies the mapped correction, emits reconciliation.resolved |
| Open, Investigating, Proposed | Dismissed | reviewer, Reject | Reason required |
| Open, Investigating, Proposed | Deferred | reviewer, Defer | `defer_until` required, at most 90 days out |
| Deferred | Open | sweep, or analyst with `POST /advance` | Sweep acts when `defer_until` has passed |

Automatic reopening of a resolved finding is not allowed. New source evidence opens a new finding that links the old one.

## AI review

| From | To | Who | Note |
|---|---|---|---|
| (requested) | Queued | editor | |
| Queued | Processing | system | |
| Processing | Needs Human Review | system | Schema-valid output, including abstention |
| Queued, Processing | Failed | system | Provider, schema or extraction failure; sweep fails anything in Processing over 5 minutes |
| Failed | Queued | editor | Retry, within quota |
| Needs Human Review | Accepted | reviewer | Suggestion taken as is |
| Needs Human Review | Accepted with Edits | reviewer | `reviewer_edits` stored, original kept, edits revalidated by the same deterministic rules |
| Needs Human Review | Rejected | reviewer | No canonical write |

Accepted states don't touch canonical records. The reviewer then commits a normal version-checked command, so model output never reaches a record directly.

Abstention reasons: `no_extractable_text`, `ambiguous`, `adversarial_content`, `missing_required_fields`.

## Outbox

`dispatch_state` is what the dispatcher did. `delivery_evidence` is what we can prove. They are separate columns because a dispatcher can finish without knowing whether anyone received anything.

| From | To | Trigger |
|---|---|---|
| (insert) | Pending | Same transaction as the business change |
| Pending, Retry Scheduled | Processing | Claim with a 130-second lease; `attempts` + 1. Template rows are never claimed |
| Processing | Processing | Lease expired, reclaimed by a later tick, below the attempt cap |
| Processing | Dead Letter | Lease expired at the attempt cap of 6 |
| Processing | Accepted | Provider took it, or check-before-append found the event |
| Processing | Simulated | Demo workspace or simulated transport |
| Processing | Retry Scheduled | Retryable failure, backoff 120 s to 1 h with jitter |
| Processing | Dead Letter | Attempts reach 6, or a non-retryable failure |
| Dead Letter | Pending | Audited operator retry, owner only, `POST /admin/automations/runs/{id}/retry` |

| Evidence | Meaning | Set when |
|---|---|---|
| None | Nothing proven | Default |
| Provider Accepted | Provider took it; row range stored in `evidence_ref` for Sheets | Accepted transition |
| Confirmed | Effect verified | Owner action with an evidence reference; future signed callback for Mode B |

Label derivation: PRD 7.2. A Mode A event stays **Accepted** until the owner records a Zap run reference. That is the honest end state for most events, and it's why `Confirmed` is optional and not a stuck state.

## Integration status

Not Configured → Simulated or Connected Test → Degraded or Disconnected. Degraded → Connected Test on a successful health check. Disconnected → Not Configured when the owner removes the connection.

## Demo session and workspace

| State | Meaning | Next |
|---|---|---|
| Active | `expires_at` in the future, 2 hours from launch | Expired |
| Reset | Old workspace expires now; session points at a new one | Purge by sweep |
| Expired | Session rejected with 401 and a clear expired message | Purge by sweep |
| Purged | Rows removed, retention row written | None |
