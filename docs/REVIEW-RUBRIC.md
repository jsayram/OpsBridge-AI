# Code review rubric and role scorecard

**Illustrative preparation material.** Written 2026-11-09 at P8.3 to show how Jose would run code review, onboarding and hiring for a small team. No candidate has been assessed with it, no hiring action has happened, and it is not evidence of managing a team (PRD JOB-15, JOB-16).

## Code review rubric

For reviewing a pull request on this codebase. Each area gets one of: **Ready**, **Needs change**, **Blocker**.

| Area | Ready looks like | A blocker looks like |
|---|---|---|
| Correctness | Does what the issue asks; edge cases have tests | Wrong result on a common path |
| Isolation and access | Workspace scope through `withWorkspace`; capability checked on the server; a negative test | A query outside the scope, or a check only in the UI |
| Data safety | Version check and idempotency where writes can race or repeat; additive migration | Lost update possible, or a migration the previous release can't run against |
| Honesty of labels | Text and labels claim exactly what the code does | "Delivered", "live" or "AI" where it isn't |
| Tests | Narrowest useful test added and passing; suite runs clean | No test for new behavior that can fail |
| Accessibility | Keyboard path works, axe passes, focus lands somewhere sensible | A control that can't be reached or named |
| Readability | A new reader follows it without the author | Clever code with no reason given |
| Scope | One change, small enough to review in twenty minutes | Unrelated changes mixed in |

**How to write feedback.** Say what you saw, why it matters and what would fix it, in that order. Separate blockers from suggestions. Ask a question when you aren't sure it's wrong. Approve when it's ready, even if you'd have written it differently.

**Sample comment (written for this rubric, not from a real review):**

> `repo/reports.ts:88`: this count runs outside `withWorkspace`, so it relies on the route alone for scope. Row-level security wouldn't catch a bug here. Could it move inside the transaction with the other queries? Blocker for me, because it's the isolation boundary.

## Role scorecard: developer on an internal-tools team

| Competency | What good looks like | How it would be checked |
|---|---|---|
| Builds working software | Ships small, tested changes to a real codebase | A paid take-home or pairing session on a small change to this repo |
| Data and integrations | Models data in SQL; handles retries, replays and partial failure | Discussion of the reconciliation and outbox design |
| Judgment about risk | Knows when to stop and ask: data, access, money | Scenario questions using the stop points in `docs/SESSION_HANDOFF.md` |
| Communication | Explains a technical tradeoff to a non-technical stakeholder | Five-minute walkthrough of a design choice |
| Learning and feedback | Takes review feedback and improves the change | The pairing session, with one round of review |

Score each 1 (not shown) to 4 (strong, with evidence). Write the evidence next to the score. Decide against the scorecard, not against other candidates' impressions, and have two people score independently before discussing.

## Onboarding exercise

The practice change at the end of `docs/ONBOARDING.md`: one small feature that touches the API spec, a route, a screen and two test suites. A new developer who finishes it with passing checks and a reviewed pull request in their first two days has seen every layer.
