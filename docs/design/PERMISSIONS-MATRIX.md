# Permissions matrix

Enforced server-side, deny by default. Every call authorizes actor, workspace, object and action. The UI hides what a role can't do, but that is usability and not security.

## Actors

| Actor | Identity | Scope |
|---|---|---|
| anonymous | None | Public pages, health, demo launch |
| guest:viewer, guest:analyst, guest:manager | Opaque demo session | One demo workspace, plus read-only template rows. The role is stored server-side and switching it is a simulation of RBAC inside the same workspace. It can never reach owner capabilities. |
| owner | Verified OIDC subject on the allowlist | Owner workspace and `/admin` |
| service:dispatcher | Worker, `opsbridge_app` role, claim functions | Outbox rows only |
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
| Upload a file | D | D | D | D | S | Guest denied, E2E-13 |
| Download a document | D | R | R | R | S | Other workspace's object |
| Request review | D | D | S | S | S | Quota |
| Live AI review | D | D | D | D | S (flag + budget) | Guest denied, E2E-14 |
| Decide AI review | D | D | D | S | S | Invalid edit, E2E-11 |
| Decide approval | D | D | D | S | S | Duplicate decision, E2E-06 |
| View reconciliation | D | R | R | R | S | |
| Advance a finding (investigate, propose, un-defer) | D | D | S | S | S | Stale version |
| Approve, reject, defer finding | D | D | D | S | S | Concurrent resolve |
| View automations, integrations | D | R | R | R | S | Redacted, E2E-03 |
| Change a workflow rule | D | D | D | D | S | Free-form URL rejected, E2E-17 |
| Retry dead letter, record confirmation | D | D | D | D | S | Guest denied |
| View analytics, reports | D | R | R | R | S | Cross-workspace export |
| Export CSV | D | S | S | S | S | Formula injection, row limit |
| ROI calculator | D | S | S | S | S | Assumptions are per session |
| Any `/admin` route | D | D | D | D | A | Edited cookie and body, E2E-03, E2E-04 |
| Live sync | D | D | D | D | A | Guest denied, P3-E |
| Emergency mode | D | D | D | D | A | |

## Database enforcement

| Layer | Rule |
|---|---|
| Grants | `opsbridge_app` has no DELETE or TRUNCATE and only SELECT on `workspaces`. `opsbridge_cleanup` has no table rights. PRD 7.4 lists all three roles. |
| RLS | Read: own workspace or template. Write: own workspace only. |
| Composite FKs | Child rows reference `(workspace_id, id)`, so a row can't point across workspaces. |
| Guard trigger | `audit_events` update and delete rules. |
| Functions | `claim_due_outbox`, `finish_outbox`, `create_demo_workspace`, `expire_demo_workspace`, `seed_demo_workspace`, `expired_demo_workspaces` and `purge_demo_workspace` are narrow `SECURITY DEFINER` with a fixed `search_path`. |
