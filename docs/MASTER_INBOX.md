# OpsBridge AI master inbox

Updated: 2026-11-06 (America/New_York), P1 phase session. The coordinator reads this first on return. No unanswered item grants permission by silence. Record the owner's actual words and the scope of the answer; retain superseded answers.

## Open decisions

### DEC-001 — Stack and hosting baseline

- State: answered for stack direction on 2026-11-06. ADR-000 proof items stay open, and provider accounts and spending remain with DEC-002.
- Context: Jose asked to discuss the stack before implementation and whether Cloudflare can host it. He asked that the PRD target the actual job and be documented in smaller steps.
- Options: retain the supplied C#/React/PostgreSQL baseline; adopt a Cloudflare-first TypeScript/Workers/D1/R2 architecture; use Cloudflare Containers for C# with externally hosted PostgreSQL.
- Recommendation: compare job proof, authorization/transaction needs, developer learning, operating burden, current platform capability and total cost in the P0 stack ADR, then obtain Jose's explicit choice. Do not choose solely to consolidate providers.
- Decision needed by: before stack-dependent P0 scaffold work and before any provisioning.
- Actual owner answer: 2026-11-06, in the planning session: “yeah im good defending typescript on the interview”, then “Lock in Postgres”.
- Authorized scope: TypeScript on Cloudflare Workers with PostgreSQL through Hyperdrive (PRD Section 6 Candidate D, `ADR/000-stack-and-hosting.md`); Neon Free is the planned provider and the app starts on Workers Free. Excludes account creation, provisioning, spending, deployment, publication and resuming implementation.
- Later owner answer, 2026-11-06: “okay so that s fine , i dont think ill get 100k request is just a demo and it will probably never ever be used ever” — taken as agreement to Workers Free and Neon Free.
- Evidence/affected scope: `PRD.md` version 1.2 Section 6 and P0; `ADR/000-stack-and-hosting.md`; `docs/JOB-ALIGNMENT.md`.

### DEC-002 — Provider, budget, identity and domain choices

- State: answered 2026-11-06 for free accounts. Jose creates them himself when asked; none exists yet.
- Package and blocking dependency: P1.1, P1.2, P1.5; P3.3, P4.3 and P5.3 later.
- Decision needed and why: P1 needs a real staging origin. Accounts, credentials and hosted resources are stop points.
- Options: (a) create Cloudflare and Neon accounts now, free plans, all owned by Jose; (b) keep building local slices of P1 and delay hosting; (c) a different provider, which reopens ADR-000.
- Consequence/cost: (a) $0 on Workers Free, Hyperdrive and Neon Free, no card needed for Neon. R2 and Zero Trust may ask for a payment method even at $0. Community reports say Zero Trust free checkout may ask to authorize overage charges, so read it before entering a card. `docs/design/COST-INVENTORY.md` has the full list as of 2026-11-06.
- Recommendation: (a) for Cloudflare and Neon, capped at 0.25 CU. Add Access only when P1.2 needs it. Also review the database exposure residual risk in `THREAT-MODEL.md` (PRD 6.3) and decide `workers.dev` versus a domain; `workers.dev` is free and enough for staging.
- Decision needed by: before P1.1 hosted work.
- Actual owner answer: 2026-11-06, forwarded by the master thread: “Yes, free accounts (Recommended)”.
- Authorized scope, as the master stated it: free Cloudflare and Neon accounts on a `workers.dev` address, Access only when owner login needs it, and the database exposure risk accepted for review in `THREAT-MODEL.md`. Jose creates the accounts himself when asked. No session creates any. Excludes spending, a domain, live integrations and any deploy not yet asked for.
- Evidence/affected scope: `PRD.md` Sections 17 and 23.3, `docs/design/COST-INVENTORY.md`.

### DEC-003 — Where PDF text extraction runs (ADR-000 proof 1b failed)

- State: answered 2026-11-06. Decide again at P5. Raised under the failed-proof stop rule.
- Package and blocking dependency: P5.1 owner upload. Public demo is unaffected.
- Decision needed and why: extraction works in workerd but costs about 2.5 ms of CPU a page locally: 1 page 4.7 ms warm and about 40 ms cold, 5 pages 13.1 ms, 20 pages 45.9 ms, against the Workers Free limit of 10 ms. It also can't be cron work on Free. Evidence: `docs/evidence/P0.2/`.
- Options with consequence/cost: (A) stay on Free. Guests use text extracted at build time (already the P0.3 design). Owner uploads wait until P5.1, and decide then. $0 now. (B) Move to Workers Paid at $5 a month when P5.1 starts, and parse in the Worker up to about 20 pages. Simple, one code path, recurring cost only while wanted. (C) Parse in the owner's browser or a local script and send text. $0, but server trust in that text drops, and it's a second path to secure.
- Recommendation: A now, then B at P5.1 if Jose wants hosted owner upload in the interview demo. No spend now, and nothing before P5 changes.
- Decision needed by: start of P5.1. A yes to A now also closes this as a stop point for P1 through P4.
- Actual owner answer: 2026-11-06, forwarded by the master thread: “Decide at P5 (Recommended)”.
- Authorized scope, as the master stated it: stay on Free now. The stop point is closed for P1 through P4. Option B or C stays undecided until P5.1.
- Resulting ADR/files: `ADR/000-stack-and-hosting.md` item 1b, `docs/reports/P0.2.md`.

### DEC-004 — Create the GitHub repository and push

- State: answered 2026-11-06, carried out by the master for `main` and `phase/p0-foundation` only.
- Package and blocking dependency: P0.5, P1.1.
- Decision needed and why: the workflow has never run on GitHub, so P0-C stays partial. Creating the repo and pushing are stop points.
- Options: (a) create a repo now and push the phase branch, private until release, then public per Jose's stated plan; (b) keep P0-C partial until P1.
- Recommendation: (a). Repo private for now, protected `main`, push `phase/p0-foundation` only. The history contains only planning and synthetic material, and gitleaks found nothing across 7 commits. Before any public flip, re-check employer-name references in planning documents.
- Decision needed by: before P1.1.
- Actual owner answer: 2026-11-06, forwarded by the master thread: “Yes, public now”.
- Authorized scope and what was done, as the master reported it: public repo https://github.com/jsayram/OpsBridge-AI, `origin` added, `main` and `phase/p0-foundation` pushed at `84c9694`, `main` protected against force-push and deletion, draft PR https://github.com/jsayram/OpsBridge-AI/pull/1 opened so CI can run. That PR must not be merged. Gitleaks found no secrets across 14 commits at the time of the push.
- Exclusions: pushing is authorized only for what Jose approved. `phase/p1-shell` is not pushed until the master says so.

### DEC-005 — Employer name in the public repository

- State: answered 2026-11-06.
- Package and blocking dependency: none blocked. Raised because the repository went public under DEC-004.
- Decision needed and why: DEC-004's recommendation said to re-check employer-name references before any public flip. `PRD.md` and the v1.0 to v1.3 snapshots name the target employer, in lines that say the project must not touch or copy that employer's systems or branding. They are public now on `main`. Nothing suggests a secret or real record; the question is only how Jose wants to appear to that employer.
- Options with consequence/cost: (a) leave it, in line with his earlier “public repo is fine”. (b) Say “the target employer” in the next PRD revision, leaving old snapshots and history as they are. The name stays findable. (c) Also rewrite history. That needs a force push, which `main` protection blocks, and it is a destructive stop point.
- Recommendation: (b) when the master next revises the PRD. Low effort and no destructive step. The master owns the PRD, so this session changed nothing.
- Decision needed by: before P8 at the latest; sooner is better since the repository is public.
- Actual owner answer: 2026-11-06, in the master thread: “Say 'target employer' (Recommended)”.
- Authorized scope: done by the master in PRD v1.4 and `docs/JOB-ALIGNMENT.md`. Old snapshots and Git history stay unchanged.

### DEC-006 — How P1 reaches staging

- State: answered 2026-11-06.
- Package and blocking dependency: hosted P1.1 and P1.5.
- Decision needed and why: `.github/workflows/release.yml` runs only from protected `main`, and P1 is on `phase/p1-shell`, which isn't pushed or merged.
- Options with consequence/cost: (a) Push `phase/p1-shell`, let CI run on a draft PR, review, then Jose approves merging into `main` and releases from there. The cleanest record, and it needs a merge approval. (b) Allow the workflow on the phase branch for the first staging deploy. No merge, but unmerged code reaches a host. (c) Jose deploys from his machine with Wrangler. No workflow evidence, so P1-E's pipeline half stays open.
- Recommendation: (a). The push alone also gets P1's checks onto real GitHub Actions.
- Decision needed by: before hosted P1.1.
- Actual owner answer: 2026-11-06, in the master thread: “Push, then merge (Recommended)”.
- Authorized scope: push `phase/p1-shell` and open a draft PR. Merging into `main` still needs Jose's separate approval. Staging releases from `main` afterward.

### DEC-007 — P1-E pending and the P2 start

- State: answered 2026-11-06.
- Package and blocking dependency: start of P2.
- Decision needed and why: PRD 14 says a missing live configuration blocks full acceptance, and moving on needs Jose's explicit, recorded deferral naming the pending criterion.
- Options with consequence/cost: (a) Do the account steps first and close P1-E, then start P2. The smallest risk of a surprise from Hyperdrive or Neon before more is built on them. (b) Accept P1 for limited scope with P1-E pending and start P2 locally. Faster, and P2 needs no account, but transaction behavior through Hyperdrive stays unproven longer.
- Recommendation: (a) if Jose can do `docs/runbooks/HOSTED-SETUP.md` steps 1 to 5 soon, since those take minutes and the Hyperdrive repeat is the largest unknown left. Otherwise (b).
- Decision needed by: before P2.
- Actual owner answer: 2026-11-06, in the master thread: “Start P2 locally”.
- Authorized scope: P1 accepted for limited scope with P1-E pending. Start P2 locally. Hyperdrive and hosted proofs stay pending and are carried into later phases.

## Recorded user direction

- 2026-11-06: “yes lets do it , make sure to do them in phased sessions and dont stop unless im absolutely needed” — resumes the build as phased sessions and delegates phase acceptance to the master thread, recorded as coordinator acceptance rather than owner acceptance. Together with Jose's prior offer terms, it approves a local Git repository, installing `psql` through Homebrew, and Hono, Drizzle and Vitest. No GitHub push. Stop points are in `docs/SESSION_HANDOFF.md`.
- 2026-11-05: “well before we get anything going lets keep chatting about the stack” — implementation paused for discussion; no inferred cancellation of the portfolio objective.
- 2026-11-05: “keep in mind this is the job im trying to impress so we need to hit all the marks here” — use the actual posting for capability coverage, with honest evidence limits.
- 2026-11-05: “using sub agents make sure its all there in the PRD” and “properly documented every step on the vault” — authorizes bounded subagent review and the planning/vault documentation revision. This is not macro-phase acceptance or provider/publication approval.
- 2026-11-06: “public repo is fine and dont care if its too heavy , it shouldb e good lets descuss the stack” — keeps the public repository plan and the full process. The private-document findings raised in review were not adopted.
- 2026-11-06: “okay cool yeah lets do that ,” — agrees to local-first development with Docker Postgres and `wrangler dev`. This does not resume the build.
- 2026-11-06: “can it not just use cloudflare?” — asked for a Cloudflare-based stack; Railway and C# were dropped after review.

## New item template

```markdown
### DEC-### — Decision title
- State: open / answered / superseded / deferred.
- Package and blocking dependency:
- Decision needed and why:
- Options with consequence/cost:
- Recommendation:
- Decision needed by gate/date:
- Actual owner answer (verbatim), time and source:
- Authorized scope and explicit exclusions:
- Resulting ADR/files/ledger entries:
- Follow-up and closure evidence:
```
