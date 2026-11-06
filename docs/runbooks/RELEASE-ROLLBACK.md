# Release and rollback plan

**State: not rehearsed on any host.** Nothing has been deployed. `.github/workflows/release.yml` has never run. DEC-002 and DEC-004 are answered, but no account exists yet, and P1-E stays pending until these steps are carried out.

## Release

Run by hand from the GitHub Actions tab, from protected `main` only, against an environment with a required reviewer.

1. `ci.yml` is green on the commit.
2. Types and unit tests run again. `scripts/check-release-config.mjs` parses the filled-in config. It refuses the test double, local connections and placeholders, and requires `/admin` to run the Worker first, the purge cron, two separate Hyperdrive configs and the rate limiter.
3. Build, then `check:bundle`.
4. Confirm by hand that query caching is off on both Hyperdrive configs. The smoke step's dead-cookie check would catch a miss, but only after the deploy.
5. `node scripts/db.mjs migrate`, then `seed`. Both are idempotent. Migrations never run on Worker boot.
6. `wrangler deploy` with the staging config. Migrations go first on purpose: under the rules below, the old Worker tolerates the new schema.
7. `node scripts/smoke.mjs <origin> --allow-remote`.

Record the commit, deployed version ID, smoke output and time in `docs/reports/`.

## Migration rules

- Expand first, contract later. A release may only add to the schema, so the previous Worker still runs against the new schema.
- Never edit an applied migration. `db.mjs` compares SHA-256 and refuses a changed file.
- Removing a column or table is a separate later release, after no running version reads it.
- A migration that can't meet these rules needs a written plan and owner approval, per PRD 19.1.

## Rollback

| Failure | Action | Data |
|---|---|---|
| Smoke fails, schema unchanged | `wrangler rollback` to the previous version | None |
| Smoke fails after an additive migration | `wrangler rollback`. Leave the schema, since the old Worker tolerates it | None |
| Isolation or auth failure on a live host | Stop. Set `DEMO_LAUNCH_PAUSED=true`, roll back, then rotate sessions by following the identity runbook | Treat as an incident, PRD 12.3 |
| Bad data from a migration | Restore a Neon branch to a point inside the 6-hour window, verify with `scripts/restore-proof.sh` steps, then repoint Hyperdrive | Loses writes since that point. Demo data is disposable; owner data needs Jose's decision |

**Schema compatibility.** `0001_foundation.sql` is the first migration, so rollback before it means an empty database. There is no down migration by design. Recovery is forward, or a restore.

## Local evidence

The restore half is proven locally by `scripts/restore-proof.sh`, on the P0 proof schema at P1 start. Migrate-twice and seed-twice are integration tests. The smoke script ran against `wrangler dev`. No rollback has been performed anywhere.
