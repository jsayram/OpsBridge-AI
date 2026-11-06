# Guided demo journey

The five-minute story from PRD 5.3, step by step, with the time budget and every non-happy state. All records are synthetic. Timing is a budget to test at P8.1, not a measurement.

| Step | Time | Visitor does | System does | Visitor sees | Labels |
|---|---:|---|---|---|---|
| 1 | 0:30 | Clicks Launch Guided Demo on `/` | Creates session, workspace and pack | Onboarding notice, five-step checklist, Overview | Simulated banner, synthetic KPIs |
| 2 | 0:45 | Clicks Create Sample Case | Case Draft → Intake, audit row, `case.created` event | Case in the list, activity entry | CRM Simulator: Simulated |
| 3 | 0:45 | Clicks Detect Mismatch | Runs matching on pack records | Finding with CRM and ERP values, timestamps, "related, not interchangeable" | ERP Simulator: Simulated |
| 4 | 1:00 | Opens Review Document, picks a fixture | Fixture review keyed by document hash | Two missing fields with page references; accept, edit or reject | Deterministic demonstration fixture |
| 5 | 1:00 | Clicks Approve Resolution | Atomic decision, audit, outbox; simulated dispatch | State changes, delivery label Simulated | Simulated |
| 6 | 1:00 | Reads recap, optionally Reset | Reset swaps in a fresh workspace | Steps, before and after, audit list, real versus simulated, hypothetical time savings | Illustrative projection |

No step waits for Zapier, an external provider or a live model.

## Personas in the story

The visitor switches between Analyst (steps 2 to 4) and Manager (step 5) with a labeled control. The label says this visualizes roles inside the demo and grants nothing else.

## States

Each row was checked against the prototypes' view-state control, or names the phase that adds it.

| Screen | Loading | Empty | Error | Stale | Denied | Other |
|---|---|---|---|---|---|---|
| Landing `/` | Static, none | N/A | Launch failure message with Retry | N/A | N/A | Launch rate limited: plain message and recorded walkthrough |
| Demo start | Waking state from PRD 13.2: message at 1 s, Retry at 8 s, walkthrough at 15 s | N/A | Request ID, Retry | N/A | N/A | Session expired: start over |
| Overview | Skeletons | Guided hint | Request ID | Stale badge | Access denied card | Waking prototype view |
| Cases | Skeletons | "No cases match" with Clear | Request ID | Stale badge | Access denied | Stale version conflict with Reload (P2.2) |
| Case detail | Skeleton | No documents yet | Request ID | Source age | Role can't act: disabled with reason | Invalid transition message (P2.3) |
| Document review | Queued, Processing | No fixture picked | Failed with Retry | N/A | Reviewer role required | Abstained, with reason |
| Reconciliation | Skeletons | No findings | Request ID | Stale badge | Access denied | Already resolved conflict (P3.4) |
| Automations (P4) | Skeleton | No runs | Request ID | N/A | Owner-only actions hidden | Accepted but unconfirmed |
| Analytics (P6) | Skeleton | Zero results | Request ID | Stale source | N/A | Degraded source |

Keyboard path: skip link, nav, checklist, then the primary action of each step. Verified on the prototypes only for tab order into the header and visible focus; a full keyboard run belongs to P1.4 and P7.4.

## Walkthrough result

Walked on paper against the prototypes on 2026-11-06. Budget total is 5:00. Issues found and resolved in design:

- The original step 4 implied an upload. Guests now pick a fixture.
- A first visit could spend its first seconds on a blank page. The waking state now covers it.
- Reset needed an answer for in-flight dispatch: the old workspace's simulated events stay with it until purge.
