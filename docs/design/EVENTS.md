# Event outline

The allowlist from PRD 9.1 is closed. Adding a type needs a PRD change. The JSON Schema is `docs/design/event-envelope.schema.json`. From P2.4 the outbox stores the whole envelope in `payload`, written in the business transaction, and a test holds its keys to the schema. From P4 the dispatcher delivers each event to the sink its workspace allows (simulated for every demo workspace).

## Envelope

| Field | Type | Note |
|---|---|---|
| `id` | UUID | Stable across retries; the sheet's dedupe key |
| `type` | enum | One of the five below |
| `version` | integer | Starts at 1 |
| `occurredAt` | UTC timestamp | |
| `workspaceMode` | `owner` or `demo` | Demo never reaches a live transport |
| `requestId` | string | Correlates with logs and audit |
| `data` | object | Per-type, no document content, no secrets |

## Types

| Type | Emitted when | `data` |
|---|---|---|
| `case.created` | Draft → Intake | `caseRef`, `caseType`, `queue` |
| `case.needs_review` | Moves to Needs Review, including reopen | `caseRef`, `reason` (`intake`, `returned`, `reopened`), `queue` |
| `approval.completed` | Approval decided | `caseRef`, `decision`, `queue` |
| `reconciliation.resolved` | Finding Resolved | `findingRef`, `kind` |
| `integration.degraded` | Connector degrades | `provider`, `status` |

`caseRef` and `findingRef` are short display references, never internal UUIDs, and carry no names. `queue` (P4, D-052) is the fictional team that owns the case, `Field Services` or `Seasonal Staffing`; rules use it to scope one typed workflow to a team. Seeded history rows carry it too.

## Idempotency keys

| Event | Key |
|---|---|
| `case.created` | `case:{id}:created` |
| `case.needs_review` | `case:{id}:review:{caseVersion}` |
| `approval.completed` | `approval:{id}`; a new approval row exists for each entry to Ready |
| `reconciliation.resolved` | `finding:{id}:resolved` |
| `integration.degraded` | `integration:{id}:degraded:{hourBucket}` |

The unique constraint on `(workspace_id, idempotency_key)` makes a duplicate insert fail inside the business transaction, which rolls back cleanly (E2E-05).
