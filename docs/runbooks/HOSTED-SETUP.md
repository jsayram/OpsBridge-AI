# Hosted setup steps for Jose

**State: not started.** Jose approved free Cloudflare and Neon accounts on 2026-11-06 (DEC-002) and creates them himself. No session creates an account, sees a password, or pastes one into chat, a file or a command line. Everything here costs $0 on the free plans as of the 2026-11-06 price check. Recheck `docs/design/COST-INVENTORY.md` if much time has passed.

Stop if any screen asks for a card. R2 and Zero Trust may ask even at $0, so read that screen first and tell the master before going on.

## 1. Accounts

1. Create a free **Cloudflare** account. Note the account ID and choose the `workers.dev` subdomain.
2. Create a free **Neon** account, then a project named `opsbridge` on Postgres 17, in a US East region.
3. In Neon, set the compute maximum to **0.25 CU**, and leave scale-to-zero on. Create a branch named `staging`.

## 2. Database roles, on the `staging` branch

1. In the Neon SQL editor, run `infra/db/bootstrap-roles.sql`.
2. Give the four roles (app, cleanup, dispatcher, migrator) a login with long generated passwords, using Neon's role screen or `ALTER ROLE … LOGIN PASSWORD`. Keep them in a password manager.
3. Keep the connection strings, with `sslmode=require`, for steps 3 and 5.

## 3. Hyperdrive, three configs with caching off

Run in this repository after `npx wrangler login`, or use the dashboard with **caching disabled**. The command prompts nothing, so type the connection string only in your own terminal.

```bash
npx wrangler hyperdrive create opsbridge-staging-app --caching-disabled --connection-string "<opsbridge_app string>"
```

```bash
npx wrangler hyperdrive create opsbridge-staging-cleanup --caching-disabled --connection-string "<opsbridge_cleanup string>"
```

```bash
npx wrangler hyperdrive create opsbridge-staging-dispatch --caching-disabled --connection-string "<opsbridge_dispatcher string>"
```

The third config is the outbox dispatcher's own role (P7.1, D-076). The release config gate refuses a deploy without it or with two bindings sharing one config.

Each prints an ID. IDs are not secret, so send them to the master.

## 4. Worker config and secrets

1. Tell the master the `workers.dev` URL the staging Worker will have: `https://opsbridge-ai-staging.<subdomain>.workers.dev`.
2. A session then writes `infra/wrangler.staging.jsonc` from the template and checks it with `scripts/check-release-config.mjs`.
3. Set the guest secret. The value is any long random string, and nobody else needs to see it.

```bash
npx wrangler secret put IP_HASH_KEY --config infra/wrangler.staging.jsonc
```

Owner login waits for step 6. Until then every `/admin` path answers 404, which is correct.

## 5. GitHub environment

In the repository settings, create an environment named `staging` with Jose as a required reviewer. Add these environment secrets:

| Name | Value |
|---|---|
| `DATABASE_MIGRATOR_URL` | The `opsbridge_migrator` connection string |
| `CLOUDFLARE_API_TOKEN` | A token limited to editing Workers on this one account |
| `CLOUDFLARE_ACCOUNT_ID` | From step 1 |

Add an environment variable `APP_ORIGIN` holding the `workers.dev` URL.

## 6. Owner login, only when it's needed

1. In Cloudflare Zero Trust, read the checkout screen before entering anything. Community reports say it may ask to authorize overage charges.
2. Create an Access application for the staging URL, covering `/admin` and `/api/v1/admin/*`, with a policy for Jose's identity only and MFA required.
3. Send the master the team domain and audience tag, which aren't secret.
4. Follow `docs/runbooks/IDENTITY.md` from step 3. Its first job is confirming that a real token has `sub` and `iat`.

## What a session does after that

Run the release workflow, then smoke, repeat ADR proofs 2 and 3 through real Hyperdrive, read real CPU, measure Neon wake-up and first visit, and rehearse a rollback. Those close P1-E. Jose also reviews the exposure note in `THREAT-MODEL.md` against the real project, per ADR proof 5.
