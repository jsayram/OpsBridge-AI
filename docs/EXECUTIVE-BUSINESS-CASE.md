# Executive business case: client-operations automation at Northstar (fictional)

One page for a decision-maker. Northstar Operations, its people and its workload are fictional. Every dollar figure below is an **illustrative projection using synthetic workload**, calculated by the ROI page (`/app/roi`, assumptions `roi-assumptions-1`). Nothing here is a saving anyone achieved, an employer's number, or a customer result. Each claim names its source in the last column of the evidence table.

## Problem

Sales keeps clients in a CRM, finance keeps bill-to entities in an ERP, and consultants track cases in spreadsheets and email. Nobody owns the answer to "who is the customer?", mismatches surface late, approvals live in inboxes, and a manager rebuilds the status report by hand. Affected functions: operations (case work and handoffs), finance (billing identity), sales (account records), consulting (client delivery) and management (reporting).

## Options

| Option | What it means | One-time cost | Running cost | Main risk |
|---|---|---|---|---|
| A. Do nothing | Keep spreadsheets and email | $0 | Today's manual time, unmeasured | Errors and late findings continue; nothing is auditable |
| B. Tidy the manual process | Shared spreadsheet, a checklist, a monthly reconciliation meeting | A few days of setup (assumed) | Same manual minutes per task | Depends on discipline; no audit trail; doesn't scale |
| C. Buy a point tool | An iPaaS or vendor reconciliation product | Vendor onboarding | Licence per seat or task (not quoted here) | Lock-in; still needs someone to own definitions |
| **D. Build the bounded platform shown in this demo** | One app: synced records, reconciliation queue, audited approvals, reviewed AI suggestions, reliable notifications, dashboards | Build time (assumed 80 hours, below) | Modeled $25 platform + $30 automation tool + AI per task | Adoption; model and integration costs once live |

## Costs and benefits (illustrative, per month, 400 tasks)

| Scenario | Hours saved | Labor value | Modeled cost | Net value |
|---|---:|---:|---:|---:|
| Conservative | 0 | $0 | $130 | **-$130** |
| Base | 53 | $1,900 | $63 | **$1,800** |
| Optimistic | 88 | $3,100 | $59 | **$3,000** |

The conservative case is a loss on purpose. It assumes review takes 7 minutes against 12 manual, and that 1 task in 5 is an exception costing 30 minutes. At those numbers automation adds time, so the calculator reports no break-even volume. The base case breaks even at 12 tasks a month.

Implementation cost is not in the PRD 11.2 formula, so it is stated separately. Assuming 80 hours of build and setup at the same $35 placeholder rate ($2,800 one-time), the base case pays it back in about 2 months and the optimistic case in about 1. The conservative case never pays it back.

The ROI percentage on the page is large (base about 2,900%) because the modeled running costs are tiny. Read net value and payback instead; a percentage over a $63 denominator says little.

## What the result depends on

From the sensitivity table on the ROI page (each input moved 20% down and up, base scenario), net value moves most with:

1. Manual minutes per task: $1,100 to $2,500.
2. Hourly labor cost: $1,400 to $2,200.
3. Tasks per month: $1,400 to $2,200.
4. Reviewed minutes per task: $2,000 to $1,600.

Platform, automation-tool and AI costs barely move it at this size (under $15 each). So the decision rests on two things nobody has measured yet: how long the manual task really takes, and how long a review of a prepared suggestion takes. **Measure both before deciding.**

## Measured versus assumed

| Claim | Measured, synthetic or assumed | Source |
|---|---|---|
| Case, finding, approval, review and event counts on the dashboard | Synthetic records, counted exactly and reconciled by tests | `/app/analytics`; metric keys in `docs/design/METRICS.md`; `tests/integration/analytics.test.ts` |
| Notification outcomes (Queued, Accepted, Confirmed, Failed, Simulated) | Synthetic; nothing is ever claimed Delivered | metric `automation_failed`, automation labels |
| AI review quality | Fixture results only, not model accuracy (standard set 100%, messy 97.9%) | `docs/evidence/P5.5/eval-report.md` |
| Time from AI review request to decision | Measured in a demo session; tiny sample, not used in ROI | metric `ai_decision_minutes` |
| Minutes per task, review minutes, exception rate, labor rate, task volume | Assumed | ROI page, `roi-assumptions-1` |
| Platform $25, automation tool $30, AI $0.02 per task | Modeled; the demo itself runs at $0 on free tiers | ROI page; `docs/design/COST-INVENTORY.md` |
| 80 hours of build, 3 manual steps per notice | Assumed | This page; metric `manual_steps_avoided` |
| Live AI cost | Unknown: live AI is Pending Owner Credentials | metric `ai_live_cost` |

## Risks

- **Assumptions drive the answer.** The sign flips between conservative and base. Mitigation: time ten real tasks each way before committing.
- **Adoption.** A queue nobody works saves nothing. Mitigation: a two-week pilot with one team, and the plan below.
- **Definitions.** "Customer" differs between sales and finance; the platform makes that visible but a person still decides. Mitigation: a named data steward.
- **Live integrations and AI** are proven here only on labeled simulations and fixtures. Costs and failure rates change once they're live.

## Adoption plan (proposed, not run)

1. Week 0: time the manual task and the review task on ten real cases each; replace the assumptions.
2. Weeks 1 and 2: pilot with one team (Field Services) in the owner workspace; weekly review of the exception queue.
3. Week 3: compare measured minutes against the base scenario; decide go, adjust or stop.
4. Then: reuse the same notification rule for the second team, as already shown with Seasonal Staffing (JOB-TEST-06, `tests/integration/automation-rules.test.ts`, `docs/reports/P4.1.md`).

No adoption, feedback or approval from real people is claimed. The stakeholders in this project are fictional personas.

## Recommendation

Choose **D, as a measured pilot**, not a rollout. The platform's value depends on manual and review minutes, which are assumptions today. A two-week pilot with timing replaces them with measurements for a modeled running cost under $130 a month. If measured review time isn't clearly below manual time, stop: that is the conservative case, and it loses money.
