# Release approval record

One record per approved step: a push, a merge, a deploy, a publication, an account-dependent rehearsal or a cost. Copy this file to `docs/approvals/YYYY-MM-DD-<step>.md`, fill it in, and commit it **before** the step runs. An empty field means the step is not approved.

A record covers exactly the step it names. It does not carry over to the next deploy, another environment, another branch or a later publication.

```markdown
# Approval: <step, for example "staging deploy of phase/p8-launch-prep">

- Step and checklist line: <docs/LAUNCH-CHECKLIST.md section and line>
- Environment or destination: <staging Worker URL / production Worker URL / GitHub repository / post or site>
- Exact artifact: <commit SHA, branch, or file path and its SHA-256>
- What will happen: <one or two sentences, in plain words>
- What will not happen: <for example "no production deploy", "no DNS change", "no live integration">
- Cost: <expected monthly and one-time cost, and the plan; "$0, free plan" when true>
- Data involved: <synthetic only / owner data / none>
- Rollback or undo: <the command or action, and whether it was rehearsed>
- Checks required before: <for example "ci.yml green on <SHA>", "check-release-config passed">
- Checks required after: <for example "smoke passed", "HTTPS and headers checked">

## Owner approval

- Approved by: Jose Ramirez
- Owner's words, verbatim: "<quote>"
- When and where: <YYYY-MM-DD HH:mm America/New_York, master thread or other source>
- Conditions or limits: <anything Jose added>

## Result (filled in after the step)

- Ran by and when: <session or person, timestamp>
- Outcome: <done / stopped at a failed check / rolled back>
- Evidence: <deployed version ID, URL, smoke output path, PR or merge commit>
- Follow-up: <none, or what is left>
```
