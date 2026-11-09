# Recovery

Local only. Hosted backup and restore (Neon point-in-time, R2) is unproven: it needs the DEC-002 accounts and is on the release-readiness list in `docs/reports/P7.md`. Everything here runs against Docker Postgres with synthetic data.

## From a backup

1. `pg_dump -Fc` the database as the admin role.
2. Create an empty database and `pg_restore --exit-on-error` into it.
3. Roles are cluster-level and don't travel in the dump. On a new cluster run `infra/db/bootstrap-roles.sql` first, then set role passwords at the provider.
4. Run `scripts/restore-proof.sh <source-db>`. It does steps 1 and 2 into `<source-db>_restore`, then compares every table's rows and checks RLS flags, policies, grants, triggers and the audit guard on the restored copy, and drops it. It stops with a non-zero exit on any mismatch.

Migrations are recorded in `ops.schema_migrations` and travel with the dump, so `node scripts/db.mjs migrate` afterward finds nothing pending or applies only what's newer.

## Restore drill

`node scripts/restore-drill.mjs [db]` is the full local drill (P7.3, E2E-23 local half): back up a disposable `*_test` database, damage it as a bad release would, restore the backup into a new database, prove every table equals the backup point and differs from the damaged source, then start the real Worker on the restored copy and run the smoke test. On 2026-11-09, on a database at `0011` with 1,984 rows: backup 235 ms, restore 377 ms, Worker ready and smoke passed in about 1.9 s. `docs/evidence/P7.3/restore-drill.txt`. Local timings say nothing about Neon.

## From the seed

The template and owner sample rows are deterministic. On an empty database:

```bash
node scripts/db.mjs setup-local opsbridge_dev
```

```bash
DATABASE_MIGRATOR_URL=postgres://opsbridge_migrator:local_dev_only@127.0.0.1:54330/opsbridge_dev node scripts/db.mjs migrate
```

```bash
DATABASE_MIGRATOR_URL=postgres://opsbridge_migrator:local_dev_only@127.0.0.1:54330/opsbridge_dev node scripts/db.mjs seed
```

`tests/integration/migrations.test.ts` proves two clean seeds hold identical records. Seeding does not restore visitor work. Demo workspaces are disposable, and a backup is the only way back to one.

## After a restart

`node scripts/restart-proof.mjs` writes through a real Worker, stops it, restarts the Postgres container, starts a new Worker and compares the state. It leaves `opsbridge_restart_test` for the restore proof. Stored idempotency keys and live demo sessions survive.

## What a restore can't do

A restored database can hold demo workspaces past their expiry. The next sweep purges them. Purged data can remain in backups until those rotate, at most 7 days (PRD 7.4).
