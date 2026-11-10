# Owner handoff runbook

For the owner, or whoever Jose names, running OpsBridge AI without the developer who built it. Each section says what to do, where the detailed steps are, and whether those steps have actually been rehearsed. Written 2026-11-09 at P8.3.

**Hosted state: none.** Every hosted step below is written from the Cloudflare and Neon documentation and the local rehearsals. None has run on a host yet. When one does, record it in `docs/reports/` and change "Not rehearsed on a host" to the date.

## Update the app

1. Make the change on a branch. Run `npm run ci:local`; it must pass.
2. Push the branch and open a pull request. `ci.yml` runs the same checks on GitHub.
3. Merge into `main` after review.
4. Release from the GitHub Actions tab with `release.yml`, which checks the release config, runs migrations, deploys and runs the smoke test (`docs/runbooks/RELEASE-ROLLBACK.md`, "Release").
5. Record the commit, the deployed version ID, the smoke output and the time in `docs/reports/`.

A schema change follows the expand-and-contract rule: a release only adds; removals wait for the next release. `migrate --to` stops before a contract migration.

| Step | Rehearsed |
|---|---|
| Local CI on a clean copy | Yes, every phase |
| Migrations one at a time, old Worker on the new schema | Yes, locally (`scripts/rollback-rehearsal.mjs`) |
| `release.yml` | Never run |

## Roll back

`npx wrangler rollback` to the previous version, then the smoke test. Leave the schema: under the migration rules the previous Worker tolerates it. Full table of cases in `docs/runbooks/RELEASE-ROLLBACK.md`, "Rollback". Rehearsed locally with two real Worker builds on one database (P7.3); not rehearsed on a host.

## Restore data

Demo workspaces are disposable; they expire in two hours and the seed rebuilds the template. Owner data, if there ever is any, comes back from Neon point-in-time restore into a new branch, checked with the restore proof, then Hyperdrive is pointed at it. Steps in `docs/runbooks/RECOVERY.md`. Rehearsed locally with `pg_dump` and the damage-and-restore drill (P7.3); Neon restore not rehearsed.

## Rotate a credential

| Credential | Where it lives | How to rotate | Rehearsed |
|---|---|---|---|
| Database role passwords (app, cleanup, dispatcher, migrator) | Neon, the three Hyperdrive configs, the GitHub release secret | New password in Neon, update the matching Hyperdrive config or secret, deploy nothing else | Not on a host |
| `IP_HASH_KEY` | Worker secret | `npx wrangler secret put IP_HASH_KEY`. Launch quotas restart, since buckets hash differently | No |
| `TOKEN_ENCRYPTION_KEY` | Worker secret | No in-place rotation: disconnect Salesforce, set a new key, reconnect (`docs/runbooks/CONNECTORS.md`, "Revocation") | No, and no Salesforce org exists |
| Google service account key | Google Cloud and a Worker secret | Create a new key, set the secret, delete the old key | No account exists |
| AI provider key | Provider and a Worker secret | Create a new key, set the secret, revoke the old one | No account exists |
| Cloudflare API token for releases | GitHub environment secret | New token with the same scopes, update the secret, revoke the old one | No account exists |

Never paste a secret into a chat, an issue, a commit or a command that lands in shell history. `wrangler secret put` prompts for the value.

## Revoke access

Guest sessions, owner sessions and each provider connection are covered in `docs/runbooks/INCIDENT.md`, step 3, with which ones were rehearsed. To stop new visitors without a deploy, set `DEMO_LAUNCH_PAUSED=true`. To stop all automation delivery, use the emergency stop on `/admin` (`docs/runbooks/AUTOMATION.md`).

## Export data

| What | How | Rehearsed |
|---|---|---|
| A report's rows | Reports page, **Export CSV**: bounded, formula-safe, same filters as the table | Yes, in Chromium (JOB-TEST-04) |
| The whole database | `pg_dump` with the migrator role, as in `scripts/restore-drill.mjs` | Yes, locally |
| Audit history | Part of the database dump. The audit table is append-only | Yes, locally |

## Shut it down

In this order, so nothing keeps running or billing:

1. Set `DEMO_LAUNCH_PAUSED=true`, then delete the Worker in Cloudflare.
2. Delete the three Hyperdrive configs.
3. Take a final `pg_dump` if anything is worth keeping, then delete the Neon project.
4. Revoke the Cloudflare API token and delete the GitHub environment secrets.
5. If they were ever created: delete the Google service account key and the sheet share, turn off and delete the Zap, revoke the Salesforce connected app, revoke the AI provider key.
6. Archive or delete the GitHub repository (deleting is permanent; archiving is reversible).
7. Let any domain lapse.

`docs/OWNERSHIP.md` lists every service with its cancel step.

## Who to ask

There is no team behind this project. The repository, `DECISIONS.md` and the phase reports are the memory. Jose Ramirez owns every account and every decision listed above.
