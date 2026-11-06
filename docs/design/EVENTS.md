# Event outline

The allowlist from PRD 9.1 is closed. Adding a type needs a PRD change. The JSON Schema is `docs/design/event-envelope.schema.json`.

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
| `case.created` | Draft → Intake | `caseRef`, `caseType` |
| `case.needs_review` | Moves to Needs Review, including reopen | `caseRef`, `reason` (`intake`, `returned`, `reopened`) |
| `approval.completed` | Approval decided | `caseRef`, `decision` |
| `reconciliation.resolved` | Finding Resolved | `findingRef`, `kind` |
| `integration.degraded` | Connector degrades | `provider`, `status` |

`caseRef` and `findingRef` are short display references, never internal UUIDs, and carry no names.

## Idempotency keys

| Event | Key |
|---|---|
| `case.created` | `case:{id}:created` |
| `case.needs_review` | `case:{id}:review:{caseVersion}` |
| `approval.completed` | `approval:{id}` |
| `reconciliation.resolved` | `finding:{id}:resolved` |
| `integration.degraded` | `integration:{id}:degraded:{hourBucket}` |

The unique constraint on `(workspace_id, idempotency_key)` makes a duplicate insert fail inside the business transaction, which rolls back cleanly (E2E-05).
