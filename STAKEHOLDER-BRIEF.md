# Stakeholder needs (fictional)

All departments and needs are hypothetical, written for the fictional Northstar Operations. No real person reviewed them. Real owner answers live in `docs/MASTER_INBOX.md`.

| Department | Need | Acceptance link | Priority call |
|---|---|---|---|
| Operations | One queue with assignment, due dates and handoff history | P2.3, JOB-TEST-02 | First: everything else hangs off cases |
| Finance | Mismatches between CRM organization and ERP bill-to, with evidence | P3.4, P3-A, P3-H | Second: the core value |
| Sales | CRM stays the source for prospects, with no surprise writes | P3-E, 8.5 | Protected by read-only sync, no extra work |
| Consulting | Document checklist and a fast first pass by AI, with a human deciding | P5.4, P5-D | Third: useful only after cases and findings exist |
| Leadership | Trustworthy counts and an honest business case | P6-A, P6-G | Last: depends on all of the above |

**Tradeoff recorded:** inventory is a read-only slice, not a build-out. A fictional operations lead would want purchasing, but that adds risk and no evidence the role asks for.

## Shared glossary

| Term | Meaning here |
|---|---|
| Customer | A canonical organization Northstar serves. Neither a CRM account nor an ERP bill-to by itself. |
| CRM organization | The sales record, which may be a prospect. |
| ERP bill-to entity | The legal entity invoiced. One organization may have several. |
| Case | A unit of consultant work with a lifecycle. |
| Finding | A recorded disagreement between sources, with evidence. |
| Workspace | The boundary around one owner's or one visitor's data. |
| Simulated | Produced by our own code, not a live third party. |
| Accepted | A provider took a request. It does not mean a person received anything. |
| Confirmed | Evidence exists that the effect happened. |

Full field definitions are in `DATA-DICTIONARY.md`.
