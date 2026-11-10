# Operator guide and adoption plan

For the person who runs OpsBridge AI day to day, and for planning how a team would start using a tool like it. Written 2026-11-09 at P8.3.

**What is real here and what isn't.** The operator steps describe the app as it works today on a local machine. The adoption plan, the training scenario and the feedback log are a **rehearsal**: no real team has used the app, no real feedback exists, and nothing below reports adoption. They are here to show how a rollout would be run.

## Daily operation

| Task | Where | How often |
|---|---|---|
| Glance at health | `GET /health/ready`, or the smoke test (`node scripts/smoke.mjs <origin> --allow-remote`) | Daily once hosted |
| Watch automation runs | `/app/automations`, plus Dead Letter on `/admin` | Daily |
| Retry or confirm a run | `/admin`, owner only (`docs/runbooks/AUTOMATION.md`) | When one fails |
| Pause new demo visitors | Set `DEMO_LAUNCH_PAUSED=true` | When something is wrong |
| Stop all delivery | Emergency stop (`docs/runbooks/AUTOMATION.md`) | When something sends what it shouldn't |
| Check a degraded source | `/app/integrations`, Resume from saved cursor (`docs/runbooks/CONNECTORS.md`) | When a card says Degraded |
| Monthly check | Dependency scan, access review, restore drill, spending review (`docs/runbooks/INCIDENT.md`, "Monthly check") | Monthly |

What the labels mean, so you can explain them to a user:

| Label | Means |
|---|---|
| Simulated (source) | Data came from a built-in simulator, not a real system |
| Deterministic demonstration fixture | A document review from a stored answer, not a language model |
| Simulated (delivery) | Recorded in the app; nothing left it |
| Accepted | An outside service took the request. It does not mean the message arrived |
| Confirmed | A person checked the far end and recorded evidence |
| Estimated, Illustrative | A projection from stated assumptions, not a measurement |

## Training scenario (rehearsal)

Twenty minutes for a new operations analyst, using a demo workspace:

1. Do the guided demo checklist with the Manager role (`docs/DEMO-SCRIPT.md`).
2. Switch to Analyst. Try to approve a case and read why the button isn't there.
3. Open the **Definition conflict** finding in Reconciliation. Explain in one sentence why one CRM organization has two ERP bill-to entities, and why that isn't a duplicate.
4. Attach the *prompt-injection* fixture to an Intake case and request a review. Point to the warning, and explain why accepting it changes nothing it shouldn't.
5. On Reports, filter to Ready cases and export the CSV. Check the row count matches the table.
6. Reset the demo.

A trainee has finished when they can say, for each of steps 3 to 5, what the app decided and what it left to a person.

## Pilot-to-rollout checklist

How a team would move from trying the tool to depending on it. Every box is unchecked: no pilot has happened.

**Before a pilot**

- [ ] A named owner, and one named person per team who reports problems
- [ ] One workflow chosen, with today's steps written down and timed by the people who do them
- [ ] Success measures agreed in advance, for example time per case and number of mismatches found, measured the same way before and after
- [ ] Data rules agreed: what data may go in, who may see it, how long it stays
- [ ] Hosted environment live, with restore and rollback rehearsed on it

**During the pilot (two to four weeks, one team)**

- [ ] Weekly fifteen-minute feedback session, logged below
- [ ] Every defect or confusing label gets an issue and an owner
- [ ] Measures collected the same way as the baseline

**Before rollout to a second team**

- [ ] Measures compared with the baseline and written up, including where the tool made things worse
- [ ] The workflow rule reused for the second team, not copied (the app's **Reuse for Seasonal Staffing** shows the mechanism)
- [ ] Training scenario updated from what the pilot taught
- [ ] Owner agrees to continue, in writing

## Feedback log

Template. **No entries are real.** The one sample row shows the format and is marked as a rehearsal.

| Date | Who (role) | What they tried | What happened | Severity | Owner | Change made |
|---|---|---|---|---|---|---|
| Rehearsal | Sample analyst | Approve a case as Analyst | No button, and the reason line said why | Low, label | Sample owner | None: works as intended |

## Measuring adoption honestly

Define measures before the pilot, measure the baseline the same way, and report only what was measured. Count active users and completed cases from the app's own records. Don't turn the ROI calculator's projections into claimed savings. If nobody used the tool, say so.
