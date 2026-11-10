# Developer onboarding

For an engineer joining OpsBridge AI, or the owner coming back after a while. Get the app running with `START-HERE.md` first. This guide gets you from a running app to a first reviewed change in about an hour.

## Day one, in order

1. Run the app and do the guided demo once (`docs/DEMO-SCRIPT.md`). Five minutes. You'll know what every screen is for.
2. Read `ARCHITECTURE.md`, sections on runtime and trust boundaries. Fifteen minutes.
3. Follow one request end to end, below. Twenty minutes.
4. Make the practice change at the end of this page and run the checks. Twenty minutes.

## The shape of the code

```
frontend/src/pages/*.tsx      screens, one file per area
frontend/src/api.ts           the only place that calls fetch
backend/src/app.ts            middleware and route mounting
backend/src/routes/*.ts       HTTP: parse, validate, check capability, open a transaction
backend/src/repo/*.ts         commands and queries inside that transaction
backend/src/domain/*.ts       pure rules: state machines, checklist gates, metrics, CSV safety
backend/src/jobs/*.ts         outbox dispatch after commit, cron sweep
backend/src/auth/*.ts         who is calling and what they may do
backend/migrations/*.sql      schema, roles, row-level security, database functions
```

Rules that hold everywhere:

- **Every query is scoped twice.** Routes pass the caller's workspace to `withWorkspace`, which sets it for the transaction, and row-level security in Postgres refuses rows from any other workspace. Never query outside `withWorkspace` for workspace data.
- **Capabilities come from the server.** `backend/src/auth/policy.ts` is the table. The UI hides buttons using the same list from `/api/v1/me`, but the server is what refuses.
- **Writes are version-checked and idempotent.** A write carries the record's `version`, and a create or decision carries an `Idempotency-Key`. A stale version gets 409; a replayed key returns the first answer.
- **Side effects go through the outbox.** A command inserts an event in the same transaction. Nothing calls an outside service from inside a request's transaction.
- **Labels are part of the data.** Delivery state, source mode and metric provenance are stored and returned, not decided by the UI.

## One request, end to end: approving a case

1. **Screen.** `frontend/src/pages/cases.tsx`, the **Approve** button on a Ready case, posts to `/api/v1/approvals/{id}/decision` with `{ decision, caseVersion }` and an idempotency key from `intentKeys()` in `api.ts`.
2. **Route.** `backend/src/routes/approvals.ts`. `requireActor` finds the caller from the session cookie; `requireCapability("approvals:decide")` refuses analysts and viewers. `readStrictJson` refuses unknown fields. The input is hashed so a replayed key with a different body is refused.
3. **Transaction.** `withWorkspace` opens a transaction scoped to the caller's workspace. `idempotent` stores the answer under the key.
4. **Command.** `decideApproval` in `backend/src/repo/caseCommands.ts` locks the case row, checks the approval is still pending and the case version matches, checks the state machine allows the move (`backend/src/domain/caseStatus.ts`), updates both rows, writes an audit row and inserts an `approval.completed` outbox event.
5. **After commit.** `backend/src/jobs/afterCommit.ts` asks the dispatcher to deliver the event. For a demo workspace the run is recorded as Simulated. A cron sweep every 30 minutes picks up anything missed.
6. **Tests.** `tests/integration/approvals.test.ts` (concurrent decisions, stale versions, injected failures at four points, replay), `tests/e2e/core.spec.ts` and `tests/e2e/automation.spec.ts` in the browser.

If you can explain those six steps, you understand the pattern every write in the app follows.

## Tests and when to run them

| Suite | Command | Needs | Run it when |
|---|---|---|---|
| Unit | `npm test` | Nothing | Any change |
| Integration | `npm run test:integration` | Docker Postgres | Any backend or SQL change |
| Query profile | `npm run test:profile` | Docker Postgres | A query or index change |
| AI evaluation | `npm run eval:ai` | Docker Postgres | AI review or fixture change |
| Browser | `npm run test:e2e` | Postgres, Chromium | Any screen change |
| WebKit | `npm run test:e2e:webkit` | Postgres, WebKit | Before a release |
| Everything, on a clean copy | `npm run ci:local` | All of the above, gitleaks | Before you ask for review |

One suite at a time: each setup drops and recreates its own database. Vitest refuses any network call to a host that isn't local (`tests/setup/no-network.ts`), so a test can't reach a real provider by accident.

## Adding things

- **An API route:** add it to `docs/design/openapi.yaml` in the same change. `tests/unit/openapi.test.ts` fails if the Worker serves a route the spec doesn't list, and the negative sweep in `tests/integration/release-negative.test.ts` then calls it as every wrong caller automatically.
- **A migration:** a new numbered file in `backend/migrations`. Never edit an applied one; `scripts/db.mjs` checks hashes. Add only; removals wait a release (`docs/runbooks/RELEASE-ROLLBACK.md`).
- **A capability:** add it to `backend/src/auth/policy.ts` and `docs/design/PERMISSIONS-MATRIX.md` together.
- **A decision someone might question later:** a line in `DECISIONS.md` with the options and why.
- **A dependency:** don't, unless it's needed. Record it in the package report, and check `npm audit` stays clean.

## Review checklist

Before asking for review, check your own diff against this list. It is the same list the project's AI reviews used.

- Does every new query run inside `withWorkspace`, and would row-level security stop it if the code were wrong?
- Can a viewer, another workspace, or a request with no session reach it? Is there a test that says no?
- Is the write version-checked and idempotent where it needs to be?
- Does any new text claim more than the code does: live, delivered, measured, AI?
- Does it work from the keyboard, and does axe pass on the screen?
- Did `npm run ci:local` pass on a clean copy?

## Practice change

Add a sixth line to the recap on the **Guided demo** page that shows how many automation runs are still Queued, using the `runs` counts the progress route already reads (`backend/src/routes/demo.ts`, `frontend/src/pages/public.tsx`). Add the field to `DemoProgress` in `docs/design/openapi.yaml`, assert it in `tests/integration/demo-progress.test.ts`, run `npm test`, `npm run test:integration` and `npm run test:e2e`, then throw the branch away. It touches the spec, a route, a screen and two test suites, which is the whole loop.
