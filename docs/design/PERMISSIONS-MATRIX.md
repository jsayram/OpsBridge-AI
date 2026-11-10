# Permissions matrix

Enforced server-side, deny by default. Every call authorizes actor, workspace, object and action. The UI hides what a role can't do, but that is usability and not security.

## Actors

| Actor | Identity | Scope |
|---|---|---|
| anonymous | None | Public pages, health, demo launch |
| guest:viewer, guest:analyst, guest:manager | Opaque demo session | One demo workspace, plus read-only template rows. The role is stored server-side and switching it is a simulation of RBAC inside the same workspace. It can never reach owner capabilities. |
| owner | Verified OIDC subject on the allowlist | Owner workspace and `/admin` |
| service:dispatcher | Worker, `opsbridge_dispatcher` role through its own Hyperdrive binding (P7.1, D-076) | Claims and finishes outbox events; reads the rules of the one workspace it sets; nothing else |
| service:cleanup | Cron, `opsbridge_cleanup` role | Expired demo workspaces only |

**Mapping to workflow roles:** analyst edits and proposes. Reviewer means guest:manager in a demo, or owner. Author and reviewer separation is by role in the demo, since one visitor plays both. In the owner workspace there is one human, so separation cannot be claimed there.

## Matrix

A = allowed, S = allowed in own workspace only, R = read-only on template rows too, D = denied.

| Action | anonymous | viewer | analyst | manager | owner | Negative test |
|---|---|---|---|---|---|---|
| View public pages, health | A | A | A | A | A | Health leaks no env data |
| Launch demo | A (rate-limited) | A | A | A | A | Quota exhaustion |
| Reset demo | D | S | S | S | D | Other session's cookie, E2E-18 |
| Switch demo role | D | S | S | S | D | Values outside viewer, analyst and manager rejected, E2E-04 |
| `GET /me` | D | S | S | S | A | Role not editable, E2E-04 |
| List and read cases | D | R | R | R | S | ID swap, E2E-02 |
| Create and edit cases, checklist | D | D | S | S | S | Mass assignment, stale version |
| Handoff | D | D | S | S | S | Unauthorized assignee, JOB-TEST-02 |
| Reopen case | D | D | D | S | S | Analyst denied, stale version |
| Attach fixture document | D | D | S | S | S | Non-allowlisted fixture ID |
| Upload a file | D | D | D | D | S, validated then refused (DEC-003) | Guest denied, E2E-13 |
| Download a document | D | R | R | R | S | Other workspace's object |
| Request review | D | D | S | S | S | Quota |
| Live AI review | D | D | D | D | S (flag + budget), Pending Owner Credentials | Guest denied, E2E-14 |
| Decide AI review | D | D | D | S | S | Invalid edit, E2E-11 |
| Decide approval | D | D | D | S | S | Duplicate decision, E2E-06 |
| View reconciliation | D | R | R | R | S | |
| Advance a finding (investigate, propose, un-defer) | D | D | S | S | S | Stale version |
| Approve, reject, defer finding | D | D | D | S | S | Concurrent resolve |
| View integrations, run history, inventory | D | S | S | S | S | Redacted, E2E-03 |
| Run a simulated sync, closed scenario list | D | D | S | S | S | Unknown scenario, other workspace, P3-E |
| Resume a failed run | D | D | D | S | S | Analyst denied, bounded |
| View automations | D | R | R | R | S | Redacted, E2E-03 |
| Change a workflow rule in its own demo workspace: enable, narrow, reuse for a team (D-059) | D | D | D | S | S | Free-form URL, recipient and code rejected, other workspace 404, E2E-17 |
| Preview a rule against a sample event | D | S | S | S | S | Read-only, nothing queued |
| Emergency stop, resume | D | D | D | D | S | Guest denied, audited |
| Retry dead letter, record confirmation | D | D | D | D | S | Guest denied |
| View analytics, reports | D | R | R | R | S | Cross-workspace export, unknown parameter refused (P6.1, P6.3) |
| Export CSV | D | S | S | S | S | Formula injection, row limit, other workspace's assignee finds nothing. A guest's export holds the same rows as the report: its own workspace plus the read-only shared samples, never another visitor's (D-071) |
| Record a daily metric snapshot (P6.1) | D | D | D | S | S | Viewer denied; one row per metric and day; template write refused by RLS |
| ROI calculator | D | S | S | S | S | Runs in the browser; assumptions are not stored |
| Any `/admin` route | D | D | D | D | A | Edited cookie and body, E2E-03, E2E-04 |
| Live sync, connect, disconnect | D | D | D | D | A | Guest denied, P3-E. Runs only against the labeled double so far |
| Emergency mode | D | D | D | D | A | |

## Database enforcement

| Layer | Rule |
|---|---|
| Grants | `opsbridge_app` has no DELETE or TRUNCATE, only SELECT on `workspaces`, and nothing at all on `demo_sessions`, `demo_quota`, `demo_limits`, `users` or `memberships`. `opsbridge_cleanup` has no table rights. PRD 7.4 lists all three roles. Exact grants are held by a test in `tests/integration/migrations.test.ts`. |
| RLS | Read: own workspace or template. Write: own workspace only, and never the template even if a bug sets it as current (`app.writable_workspace()`). Every `app` table has RLS on. |
| Composite FKs | Child rows reference `(workspace_id, id)`, so a row can't point across workspaces. |
| Guard trigger | `audit_events` update and delete rules. |
| Functions | Narrow `SECURITY DEFINER` with a fixed `search_path`. Runtime: `launch_demo_session`, `resolve_demo_session`, `reset_demo_session`, `set_demo_role`, `resolve_owner`, `revoke_owner_sessions`. Cleanup: `expired_demo_workspaces`, `purge_demo_workspace`, `purge_stale_demo_quota`, `purge_expired_idempotency_keys`. Internal, granted to nobody: `create_demo_workspace`, `seed_demo_workspace`, `take_workspace_quota`. `release_deferred_findings` is cleanup-only. P4 added `claim_due_outbox` and `finish_outbox` for the runtime role; since P7.1 (D-076) only `opsbridge_dispatcher` may call them. The runtime role keeps the owner-workspace-only `retry_dead_letter`, `confirm_outbox`, `set_automation_pause`, which check `current_mode()` themselves. |
| Connection guards | `connection_mode_guard` refuses a live connection outside the owner workspace, and `owner_only_row` does the same for `connection_secrets` and `oauth_states`, whatever the application does. |

## Status at P3

`backend/src/auth/policy.ts` implements the rows that exist so far: read, create and edit cases, checklist, handoff, reopen, decide approval, reconciliation, integrations, inventory, reset, switch role, `GET /me` and admin. Simulated sync is a route of its own, beside the owner route in PRD 8.2, so the public demo can show ingestion without any live path: it can only build a simulator. Every other row stays denied by default because its route doesn't exist yet. The owner column runs only against the local test double, so it is Pending Owner Configuration.

Status moves that need a reviewer are checked per transition in `backend/src/domain/caseStatus.ts`, on top of the capability check at the route.
