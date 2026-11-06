# Entity relationship design

Migrations arrive in P2.1. This is the schema those migrations must implement. `spikes/p0.2/sql/001_schema.sql` proves the role, RLS and audit parts on a subset.

Conventions: UUID keys, UTC `timestamptz`, `workspace_id` on every business table, composite primary keys `(workspace_id, id)` so child foreign keys carry the workspace. Field lists match PRD 7 and 7.3.

```mermaid
erDiagram
  workspaces ||--o{ memberships : has
  users ||--o{ memberships : joins
  workspaces ||--o{ demo_sessions : has
  workspaces ||--o{ customers : owns
  workspaces ||--o{ cases : owns
  customers ||--o{ cases : for
  cases ||--o{ documents : has
  cases ||--o{ case_checklist_items : has
  cases ||--o{ consultant_handoffs : has
  cases ||--o{ approvals : has
  documents ||--o{ ai_reviews : has
  workspaces ||--o{ external_connections : has
  workspaces ||--o{ external_record_links : has
  external_record_links ||--o{ customer_source_relationships : maps
  customers ||--o{ customer_source_relationships : has
  workspaces ||--o{ sync_runs : has
  workspaces ||--o{ source_definition_mappings : has
  workspaces ||--o{ reconciliation_findings : has
  workspaces ||--o{ inventory_items : owns
  inventory_items ||--o{ inventory_snapshots : has
  workspaces ||--o{ workflow_rules : has
  workspaces ||--o{ outbox : has
  workspaces ||--o{ audit_events : has
  workspaces ||--o{ metric_snapshots : has
  workspaces ||--o{ idempotency_keys : has

  workspaces { uuid id PK
    text name
    text mode "owner, demo, template"
    timestamptz created_at
    timestamptz expires_at "required when demo" }
  users { uuid id PK
    text oidc_subject UK
    text email_display
    bool active }
  memberships { uuid workspace_id PK
    uuid user_id PK
    text role }
  demo_sessions { uuid id PK
    uuid workspace_id FK
    bytea token_hash UK
    text demo_role
    timestamptz expires_at
    jsonb quota_counters }
  demo_quota { bytea ip_bucket PK
    timestamptz hour PK
    int launches }
  customers { uuid workspace_id PK
    uuid id PK
    text canonical_name
    text account_code
    text lifecycle_status
    int version }
  cases { uuid workspace_id PK
    uuid id PK
    uuid customer_id FK
    text case_type
    text status
    uuid assignee_id
    timestamptz due_at
    int version }
  documents { uuid workspace_id PK
    uuid id PK
    uuid case_id FK
    text object_key "owner uploads"
    text fixture_id "guest path"
    bytea sha256
    int size
    text verified_type
    text status }
  approvals { uuid workspace_id PK
    uuid id PK
    uuid case_id FK
    text proposed_action
    jsonb proposed_payload
    text status
    uuid actor_id
    timestamptz decided_at
    text reason }
  ai_reviews { uuid workspace_id PK
    uuid id PK
    uuid document_id FK
    text model_version
    text prompt_version
    jsonb extraction "immutable"
    jsonb citations
    jsonb reviewer_edits
    text status
    text abstain_reason
    timestamptz processing_started_at
    int cost_units }
  reconciliation_findings { uuid workspace_id PK
    uuid id PK
    text entity_type
    uuid entity_id
    text kind
    text severity
    jsonb source_values
    text status
    timestamptz defer_until
    int version
    timestamptz resolved_at
    uuid supersedes_id }
  outbox { uuid workspace_id PK
    uuid id PK
    text event_type
    text payload_ref
    text idempotency_key UK
    text dispatch_state
    text delivery_evidence
    text evidence_ref
    int attempts
    timestamptz next_attempt_at
    timestamptz lease_expires_at }
  audit_events { bigint id PK
    uuid workspace_id FK
    text actor_type
    text actor_id
    text action
    text target
    text before_hash
    text after_hash
    text request_id
    timestamptz occurred_at }
  idempotency_keys { uuid workspace_id PK
    text key PK
    bytea request_hash
    int response_status
    jsonb response_body
    timestamptz created_at }
  retention_log { bigint id PK
    uuid workspace_id "no FK, workspace is gone"
    timestamptz purged_at
    int audit_rows
    int business_rows }
```

Tables without a line in the diagram but with the same conventions: `consultant_handoffs`, `case_checklist_items`, `external_connections`, `external_record_links`, `sync_runs`, `workflow_rules`, `metric_snapshots`, `inventory_items`, `inventory_snapshots`, `source_definition_mappings`, `customer_source_relationships`. Their fields are in PRD 7 and 7.3 and are not repeated here, so the PRD stays the single list.

## Constraints that carry weight

| Constraint | Why |
|---|---|
| `CHECK ((mode = 'demo') = (expires_at IS NOT NULL))` | A demo workspace can't live forever, and an owner workspace can't expire |
| Partial unique index on `workspaces(mode) WHERE mode = 'template'` | Exactly one template |
| `UNIQUE (workspace_id, idempotency_key)` on outbox | One durable event per business intent |
| `UNIQUE (workspace_id, provider, external_type, external_id)` | Repeat sync can't duplicate |
| `CHECK ((object_key IS NULL) <> (fixture_id IS NULL))` on documents | A document is an upload or a fixture |
| `CHECK (status <> 'Deferred' OR defer_until IS NOT NULL)` | A deferral always has a date |
| Status and enum CHECKs | The database rejects vocabulary drift |

## Indexes from day one

`outbox (next_attempt_at) WHERE dispatch_state IN ('pending','retry_scheduled','processing')`, `cases (workspace_id, status, created_at)`, `documents (workspace_id, case_id)`, `workspaces (expires_at) WHERE mode = 'demo'`. Others wait for `EXPLAIN ANALYZE` evidence (PRD 7.1).
