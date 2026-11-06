# Environment reference

Local is the only environment that exists. Staging and production are not created, because they wait on DEC-002 and DEC-004. This file lists names and purposes only. Values live in host-managed secrets, never in this repository.

## Environments

| | Local | Staging | Production |
|---|---|---|---|
| State | Working | **Not created** | **Not created** |
| Worker | `wrangler dev` | `opsbridge-ai-staging`, separate Worker | `opsbridge-ai`, separate Worker |
| Database | Docker Postgres 17 on `127.0.0.1:54330`, database `opsbridge_dev` | Neon branch with its own credentials | Neon main |
| Path to database | Direct, through `localConnectionString`. **Hyperdrive is not in the path** | Hyperdrive, caching off | Hyperdrive, caching off |
| Config | `wrangler.jsonc` | Copy of `infra/wrangler.staging.template.jsonc` | Same template, own values |
| Owner identity | Unset (404), or the local test double in tests | Access, after DEC-002 | Access, after DEC-002 |

Staging uses its own data and credentials. Nothing is shared with production.

## Variables

Set in the Wrangler config. Not secret.

| Name | Purpose | Local | Hosted |
|---|---|---|---|
| `ENVIRONMENT` | Selects local-only behavior. Missing is treated as production | `local` | `staging` or `production` |
| `APP_ORIGIN` | The one origin allowed to send state changes | Unset, uses the request origin | Required. State changes get 403 without it |
| `OWNER_IDENTITY_MODE` | `access`, or unset. `local-test-double` is refused outside local loopback | Unset | `access` |
| `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com`. Sets the issuer and JWKS URL | Unset | Required for owner identity |
| `ACCESS_AUD` | Access application audience tag | Unset | Required for owner identity |
| `DEMO_LAUNCH_PAUSED` | `true` stops launch and reset | Unset | Unset, flip in an incident |
| `SYNC_PAGES_PER_CALL` | Source pages one request handles, 1 to 8. The client continues a longer run | Unset, 8 | `1` on Workers Free |
| `SALESFORCE_ENABLED` | `true` turns on the owner-only connector. Off unless every Salesforce value is set | Unset | Unset until P3-D is authorized |
| `SALESFORCE_LOGIN_URL` | `https://` host under `salesforce.com`. Anything else keeps the connector off | Unset | Owner's org |
| `SALESFORCE_CLIENT_ID` | External client app consumer key | Unset | Owner's app |
| `SALESFORCE_REDIRECT_URI` | `<origin>/api/v1/admin/integrations/salesforce/callback` | Unset | Must match the app |

Demo limits are not variables. They live in `app.demo_limits`, which only a migration can change: 5 new workspaces an hour per client network (launch and reset share it), 5 resets a session, 150 workspaces and a 2-hour TTL that a CHECK constraint keeps at or below 2 hours. An IPv6 client counts as its /64.

## Secrets

Set with `wrangler secret put`. Never in a file, command line or chat.

| Name | Purpose | Failure if missing |
|---|---|---|
| `IP_HASH_KEY` | Keys the HMAC on client addresses, so quota rows hold no address | Demo launch answers 503 |
| `OWNER_SUBJECT_ALLOWLIST` | Comma-separated exact subjects | Admin paths answer 404 |

Local uses a throwaway value in `.dev.vars`, copied from `.dev.vars.example`.

## Bindings

| Binding | Purpose | Notes |
|---|---|---|
| `HYPERDRIVE` | Request path, role `opsbridge_app`, 5 s statement timeout | **Query caching must be off.** Session and owner lookups are `SELECT` calls, so a cached answer could keep a dead cookie alive |
| `HYPERDRIVE_CLEANUP` | Cron path, role `opsbridge_cleanup`, 30 s statement timeout | Second config, caching off. Free allows 10 |
| `ASSETS` | React build | `/admin` runs the Worker first |
| `API_RATE_LIMITER` | 120 requests a minute per hashed address, an approximate outer layer | Worked under local workerd. Availability on Workers Free is not confirmed. The app runs without it |
| Cron `*/30 * * * *` | Purges at most 5 expired workspaces a run | Wakes Neon. No keep-warm is allowed |

## Release secrets (GitHub environment, none exist yet)

| Name | Purpose | Scope |
|---|---|---|
| `DATABASE_MIGRATOR_URL` | Migrations and seed, role `opsbridge_migrator` | That environment only |
| `CLOUDFLARE_API_TOKEN` | Deploy | Workers edit on one account, nothing else |
| `CLOUDFLARE_ACCOUNT_ID` | Deploy target | Identifier, not a secret, kept with the token |

## Database roles

`infra/db/bootstrap-roles.sql` creates the three roles from PRD 7.4 without passwords, and an administrative connection runs it once. Hosted passwords are long generated values that the owner sets at the provider. `opsbridge_app` and `opsbridge_cleanup` go into their Hyperdrive configs. `opsbridge_migrator` goes only into the release secret.

## Before hosted work

Each of these is a stop point for Jose, routed through the master inbox.

DEC-002, DEC-003 and DEC-004 are answered (`docs/MASTER_INBOX.md`). Free accounts on `workers.dev` are approved, and Jose creates them himself when asked. The repository is public with `main` protected.

- [ ] Jose creates the Cloudflare and Neon accounts. Neon capped at 0.25 CU.
- [ ] Hyperdrive configs created with caching off, then confirmed, since nothing in code can check it.
- [ ] Access application created when owner login is needed, with MFA required.
- [ ] Jose reviews the database exposure residual risk in `THREAT-MODEL.md` against the real project.
- [ ] Staging exposure: who may reach it.
- [ ] The master says when `phase/p1-shell` may be pushed.
- [ ] Enable HSTS once the origin is verified. The Worker sends it off today, per PRD 6.3.
