# OpsBridge AI master inbox

Updated: 2026-11-06 (America/New_York). The coordinator reads this first on return. No unanswered item grants permission by silence. Record the owner's actual words and the scope of the answer; retain superseded answers.

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

- State: deferred owner decision; not blocking planning.
- Context: no provider-account or public-release choice is made by this documentation task.
- Options/recommendation: present the concrete service inventory now that DEC-001 has a stack direction, including current prices, budget/caps versus alerts, ownership, cancellation, auth/MFA feasibility, private storage, and preview/production separation. Reuse approved owner accounts where suitable.
- Decision needed by: relevant P0 provider gate, before creating resources or enabling live access.
- Actual owner answer: none recorded for provisioning, spending, identity provider, domain, live integrations or publication.
- Evidence/affected scope: `PRD.md` owner decisions and spending policy.

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
