# Incident runbook

**State: rehearsed locally on 2026-11-09 (P7.3), never on a host.** Every step below ran in order in `tests/integration/incident-drill.test.ts` against Docker Postgres and the in-process Worker, with the providers as labeled doubles. On a host the same switches are Worker variables and secrets, set with `wrangler secret put` or the dashboard, and each change is a new deployment.

PRD 12.3 asks for: revoke provider keys, disable affected features, pause integrations, rotate sessions, inspect logs, redeploy a safe version, restore if required, and document impact. This file is that list for OpsBridge AI. All data in the app is synthetic, so an incident is about access, cost and trust, not about real people's records.

## Who does what

Jose owns every step. No session or agent runs these on a host. Local rehearsals are fine.

## 1. Notice and record

- Note the time, what was seen, and the request ID from the error envelope or the `x-request-id` header.
- Find the log lines: every request writes one redacted JSON line with `requestId`, route, status, actor kind and error code. No cookie, token, body, query or address is logged (`tests/integration/shell-api.test.ts`).
- Decide which kind: guest isolation or auth failure, owner compromise, provider key exposure, cost spike, bad data, or availability.

## 2. Contain

Use the narrowest switch that stops the harm. Each one leaves the rest of the app working.

| Switch | What it stops | How | Rehearsed |
|---|---|---|---|
| `DEMO_LAUNCH_PAUSED=true` | New demo workspaces and resets. Existing sessions keep reading | Worker variable | Yes |
| Automation emergency stop | Every outbox dispatch. Events wait in their state; nothing is dropped | Admin page, or `POST /api/v1/admin/automations/pause` with a reason. Audited | Yes |
| Remove `AI_LIVE_ENABLED` or `AI_API_KEY` | Every live AI call. Reviews fall back to the labeled fixture | Worker secret | Yes |
| Remove `SHEETS_ENABLED` or `GOOGLE_SA_KEY` | The Sheet bridge. Owner events finish Simulated | Worker secret | Yes, through config |
| Remove `SALESFORCE_ENABLED` | Every Salesforce call. The connector page says it is off | Worker variable | Yes, through config |
| Remove `OWNER_SUBJECT_ALLOWLIST` | Every admin path answers 404, without touching data | Worker secret | Covered in `owner-identity.test.ts` |
| Roll back the Worker | A bad release | `wrangler rollback`, rules in `RELEASE-ROLLBACK.md` | Locally, `scripts/rollback-rehearsal.mjs` |

## 3. Revoke and rotate

| What | How | Effect | Rehearsed |
|---|---|---|---|
| Owner sessions | `POST /api/v1/admin/logout`, or as the migrator set `users.active = false` | Any token issued before that second is refused | Yes |
| Guest sessions | As the migrator: `UPDATE app.demo_sessions SET expires_at = now()` | Every guest cookie stops working on its next request; visitors can launch again unless launches are paused | Yes |
| Salesforce token | Admin page Disconnect, or `POST /api/v1/admin/integrations/{id}/disconnect` | Revokes at the provider, scrubs the stored ciphertext, blocks sync | Yes, against the double |
| Google service account key | Delete the key in Google Cloud, then remove the Worker secret | The bridge stops; owner events retry, then dead-letter | No: no account exists |
| AI provider key | Revoke at the provider, then remove the Worker secret | Live AI off; fixture answers | No: no account exists |
| Zapier hook | Turn the Zap off in Zapier | Nothing reaches Zapier from the app directly | No: no account exists |
| Token encryption key | Not rotatable in place yet: disconnect Salesforce first, change `TOKEN_ENCRYPTION_KEY`, reconnect | Old ciphertext unreadable | No |
| Database role passwords | Change at Neon, update the Hyperdrive config | Old password refused | No: no account exists |

## 4. Recover

1. Fix forward or roll back (`RELEASE-ROLLBACK.md`).
2. Restore only if data is wrong: `RECOVERY.md`. Demo workspaces are disposable; owner data needs Jose's decision.
3. Resume what was paused, one switch at a time, and watch the next requests. Held outbox events dispatch on the next pass or cron tick; the drill proves none is lost.
4. Run `node scripts/smoke.mjs <origin> --allow-remote` on a host, or the local smoke.

## 5. Write it down

In `docs/reports/`, a short note: what happened, when it was noticed and fixed, which requests and workspaces were affected, what was switched off and back on, what changes so it can't recur. The audit trail already holds `automation.paused`, `automation.resumed`, `owner.logout` and `connection.disconnected`; quote their times.

## Monthly check (PRD 12.3)

Dependency updates and `npm run scan:security`, access review (allowlist, Access policy, provider keys), a local restore drill (`scripts/restore-drill.mjs`), and the spending review in `docs/design/COST-INVENTORY.md`.
