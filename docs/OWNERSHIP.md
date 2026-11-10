# Ownership and cost inventory

Who owns what, what it costs, and how to cancel it. Written 2026-11-09 at P8.3. Prices come from `docs/design/COST-INVENTORY.md`, checked against vendor pages on 2026-11-06; recheck before creating anything.

**Today the monthly cost is $0, because nothing exists yet.** No account below has been created. Every row stays "Not created" until Jose creates it and records the date here.

## Services

| Service | Purpose | Plan | Expected monthly cost | Owner | Who can change it | Cancel or revoke | State |
|---|---|---|---|---|---|---|---|
| GitHub repository `jsayram/OpsBridge-AI` | Source, CI, releases | Free, public | $0 | Jose | Jose | Archive (reversible) or delete (permanent) | Exists, public. `main` and two phase branches pushed; later phase branches are local only |
| Cloudflare account and Worker | App and API | Workers Free | $0 | Jose | Jose; GitHub release job through a scoped API token | Delete the Worker, revoke the token | Not created |
| Hyperdrive, three configs | Pooling for app, cleanup and dispatcher roles | Included | $0 | Jose | Jose | Delete each config | Not created |
| Neon project `opsbridge` | PostgreSQL 17, `staging` branch | Free, 0.25 CU cap | $0 | Jose | Jose | Delete the project after a final dump | Not created |
| Cloudflare Access | Owner sign-in | Zero Trust Free | $0, but checkout may ask for a card | Jose | Jose | Remove the application | Optional |
| Cloudflare R2 | Private documents and backups | Free tier | $0 within limits | Jose | Jose | Delete the bucket | Proposed, not needed for the demo |
| Domain | Friendly URL | Optional | Registrar price | Jose | Jose | Let it lapse | Not planned; `workers.dev` works |
| Salesforce Developer Edition | Live read-only CRM test | Free | $0 | Jose | Jose | Revoke the connected app | Optional, not created |
| Google Cloud project, service account, Sheet | Bridge to Zapier | Free | $0 | Jose | Jose | Delete the key, unshare the sheet | Optional, not created |
| Zapier | One trigger, one action | Free | $0, 100 tasks a month | Jose | Jose | Turn off and delete the Zap | Optional, not created |
| AI provider | Owner-only live document review | Pay as you go | Set a hard budget first; none chosen | Jose | Jose | Revoke the key | Optional, not created |

Expected monthly total once staging exists on the free plans: **$0**, with two places where a card might be requested (Access and R2). Stop and decide before entering one. The app keeps working without both.

## Free-plan limits that matter

- Workers Free: 10 ms CPU per request, 100,000 requests a day. Analytics and report routes need a CPU measurement on real hardware (P7 list, item 7).
- Neon Free: 100 CU-hours a month. The 30-minute cron sweep uses about 30 at 0.25 CU, which leaves about 70 for traffic.
- Demo capacity: 150 workspaces, purged 5 every 30 minutes. A full burst can refuse new visitors for hours (P7, Medium availability risk). Decide the policy after the CPU measurement.

## Secrets and where they live

Names only. No value is stored in the repository, a document or a chat.

| Secret | Lives in | Set by |
|---|---|---|
| Database role passwords (4) | Neon, Hyperdrive configs, the GitHub `DATABASE_MIGRATOR_URL` secret | Jose |
| `IP_HASH_KEY` | Worker secret | Jose |
| `OWNER_SUBJECT_ALLOWLIST`, Access team and audience | Worker variables | Jose |
| `TOKEN_ENCRYPTION_KEY` | Worker secret, only if Salesforce is connected | Jose |
| Google service account key | Worker secret, only if the bridge is used | Jose |
| AI provider key | Worker secret, only if live AI is used | Jose |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub environment secrets | Jose |

## People

| Role | Person |
|---|---|
| Owner, every account, every approval | Jose Ramirez |
| Developer | Jose Ramirez, working with AI coding tools |
| Operator | Jose Ramirez until he names someone |
| Independent reviewer | None yet |

If someone else takes over, give them their own accounts or seats rather than sharing logins, rotate every secret in the table above after the handover (`docs/runbooks/HANDOFF.md`), and record the change here.
