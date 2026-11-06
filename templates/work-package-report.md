# Px.y — Package report

Report time/timezone: `<actual>`. Parent phase: `Px`. PRD version/hash: `<actual>`. Writer/reviewer: `<actual>`. Revision/branch: `<actual or not established>`.

## Outcome and scope

State what changed, why it serves the operator/business/job requirement, what was not attempted, and whether the bounded goal was reached. Keep planned, implemented, verified, accepted, merged and deployed separate.

## Changed artifacts

| File/contract/migration | Change and reason | Requirement ID |
|---|---|---|
| `<path>` | `<observable change>` | `<ID>` |

Migration state: `<none / authored / applied to named environment>`. Data/backward compatibility and recovery impact: `<actual>`. Do not claim a migration ran because its file exists.

## Verification actually performed

| Time/environment/revision | Exact safe command or manual scenario | Result | Durable evidence |
|---|---|---|---|
| `<actual>` | `<without secrets>` | `<passed/failed/blocked/not run>` | `<path or CI run>` |

List expected checks not run and why. Explain failures, repeatability limits, fixture size, simulation/live modes, screenshots or API evidence, and any redaction. An agent statement is not proof of execution.

## Security, quality and cost

- Authorization/trust boundaries and privacy:
- Accessibility and degraded/failure states:
- Dependency/secret/security findings and remediation:
- Provider usage, cost/quotas and new resource commitments:
- Known defects, unresolved findings and residual risk:

## Decisions, teaching notes and approvals

Summarize the important concept in plain language, options considered, chosen rationale and tradeoff. Link the ADR and master inbox item. Quote an actual owner answer only when received; otherwise record pending. Do not include private chain-of-thought or credentials.

## Release, rollback and continuity

- Release/deployment state (environment/revision or not deployed):
- Rollback/recovery instruction and whether rehearsed:
- Services/locks started, retained or stopped by this package:
- Vault package/checkpoint paths and verified read-back:
- PRD mirror/manifest update required? Actual result:
- Coordinator review and remaining conditions:
- Next exact action, prerequisites and owner decision needed:

Do not advance to a new macro phase until Jose accepts the phase. A review does not authorize a merge, push, external action or release.
