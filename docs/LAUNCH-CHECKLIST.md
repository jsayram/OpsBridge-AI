# Launch checklist (P8.4)

**State: prepared, nothing done.** Written 2026-11-09 by the P8 session. No account, deploy, push, merge or publication has happened, and none may happen without Jose's explicit approval for that step. Every box below is unchecked.

Each step names who does it. **Jose** means only Jose can do it: it involves an account, a credential, money, a public URL or a merge. **Session** means a Claude Code session may do it, but only after the approval named in that step is recorded in `docs/MASTER_INBOX.md`, using the record in `templates/release-approval-record.md`.

Stop the launch at any failed check. Don't work around it; record it and ask.

## A. Before any account (done locally)

- [x] P0 to P7 coordinator accepted for limited scope; P8 run locally (`docs/PHASE-LEDGER.md`)
- [x] Clean-copy `npm run ci:local` passed on the release candidate (`docs/reports/P8.md`)
- [x] Release-readiness list from P7 carried into this checklist
- [ ] **Jose** reads `docs/reports/P8.md` and accepts or revises P8

## B. Accounts and configuration (Jose, `docs/runbooks/HOSTED-SETUP.md`)

- [ ] **Jose** creates the free Cloudflare account and picks the `workers.dev` subdomain. Stop if a card is requested.
- [ ] **Jose** creates the free Neon project `opsbridge`: Postgres 17, US East, compute capped at 0.25 CU, scale to zero on, branch `staging`.
- [ ] **Jose** runs `infra/db/bootstrap-roles.sql` on `staging` and gives the four roles long generated passwords kept in a password manager.
- [ ] **Jose** creates three Hyperdrive configs with caching off (app, cleanup, dispatcher) and sends the master the three IDs, which aren't secret.
- [ ] **Jose** sends the master the staging URL. A session writes `infra/wrangler.staging.jsonc` and runs `node scripts/check-release-config.mjs` on it. **Must pass.**
- [ ] **Jose** sets `IP_HASH_KEY` with `wrangler secret put`, and `OWNER_SUBJECT_ALLOWLIST` if owner login is wanted now.
- [ ] **Jose** creates the GitHub `staging` environment with himself as required reviewer, and the secrets `DATABASE_MIGRATOR_URL`, `CLOUDFLARE_API_TOKEN` (Workers edit on this account only), `CLOUDFLARE_ACCOUNT_ID`, and the variable `APP_ORIGIN`.
- [ ] **Jose** decides: Cloudflare Access now, or `/admin` answering 404 for the first deploy (recommended: 404 first).
- [ ] **Jose** confirms in the dashboard that query caching is off on all three Hyperdrive configs.

## C. Source approvals (Jose)

- [ ] **Jose** approves pushing `phase/p2-core` through `phase/p8-launch-prep` and opening draft pull requests. Approval record required.
- [ ] GitHub Actions `ci.yml` passes on the pushed branches. If it fails, stop and fix on the branch.
- [ ] **Jose** approves merging into `main`. Approval record required. Merges happen in phase order, or as one reviewed merge of `phase/p8-launch-prep`, whichever Jose picks.
- [ ] **Jose** picks a license, or "all rights reserved", and a session adds it.
- [ ] **Jose** turns on GitHub private vulnerability reporting; a session puts the channel in `SECURITY.md`.

## D. Staging deploy (session, after Jose approves the deploy)

- [ ] Approval record for "staging deploy" filled in and committed.
- [ ] `release.yml` run from `main` against `staging`: config gate, types, unit tests, build, `check:bundle`.
- [ ] Migrations: on an empty staging database, `migrate` to `0011` in one release is allowed. Every later release follows expand then contract (`docs/runbooks/RELEASE-ROLLBACK.md`).
- [ ] `seed`, then `wrangler deploy`.
- [ ] `node scripts/smoke.mjs https://<staging URL> --allow-remote` passes. Record the output.
- [ ] HTTPS: the URL serves only over HTTPS, the session cookie is `__Host-`, Secure, HttpOnly, SameSite=Strict, and security headers match the local test (`tests/e2e/shell.spec.ts`).
- [ ] Record commit, deployed version ID, smoke output and time in `docs/reports/P8.4.md`.

## E. Hosted rehearsals (session, after Jose approves each)

- [ ] Negative sweep against staging (P7.2, read-only for other workspaces).
- [ ] ADR-000 proofs 2 and 3 through real Hyperdrive.
- [ ] Workers CPU per request on `/api/v1/analytics/overview` and a report route. Over 10 ms means a decision: smaller queries, or Workers Paid ($5 a month). That is Jose's call.
- [ ] Neon wake-up and first-visit timing against PRD 13.2: landing under 2 s, launch under 5 s at p95.
- [ ] `wrangler rollback` to the previous version and back, with smoke after each.
- [ ] Neon point-in-time restore into a new branch, checked with the restore proof.
- [ ] Demo capacity policy decided by Jose after the CPU numbers (cap 150, purge 5 every 30 minutes today).

## F. People checks (Jose, or someone he names)

- [ ] Real Safari on a Mac: the guided demo, including **New case** right after the case list loads.
- [ ] A physical iPhone: the guided demo.
- [ ] VoiceOver on the guided demo, `/app/analytics`, `/app/reports` and `/app/roi`. Record who ran it.
- [ ] One first-time visitor runs the guided demo from `docs/DEMO-SCRIPT.md`, timed, without help (P8-A). Record the time and what confused them.
- [ ] Jose follows `START-HERE.md` and one runbook in `docs/runbooks/HANDOFF.md` himself, or names who does (JOB-TEST-07).

## G. Public launch (Jose approves each item separately)

- [ ] **Jose** approves the production Worker (a separate Neon branch or project, separate secrets, same checks as section D). Approval record required.
- [ ] Production smoke, HTTPS and header checks pass. Record in `docs/reports/P8.4.md`.
- [ ] Update the evidence page (`/about/engineering`) and `README.md` status from the recorded results only.
- [ ] **Jose** reads and approves `docs/CASE-STUDY.md`. Approval record required before it is shared.
- [ ] **Jose** records, reviews and approves the video (`docs/DEMO-SCRIPT.md`, shot list). Approval record required before it is posted.
- [ ] **Jose** approves sharing the public URL. Approval record required.
- [ ] **Jose** signs off the monthly cost, expected $0 (`docs/OWNERSHIP.md`), and who holds each account (P8-F).

## After launch

- [ ] Monthly check from `docs/runbooks/INCIDENT.md`.
- [ ] Optional, each with its own approval: CodeQL in CI, WebKit in CI, a Salesforce Developer Edition org (P3-D), a Google Sheet and Zap (P4-C), an AI provider with a hard budget (P5.3).
