# OpsBridge AI business brief

One page, for someone who will not read the code. Northstar Operations is fictional, and every process, cost and name here is synthetic. The manual baseline is assumed, not measured.

## The problem

Northstar runs seasonal-services client work across three places that don't agree: sales keeps organizations in a CRM, finance keeps bill-to entities in an ERP, and consultants track cases in spreadsheets and email. When a client's name or account differs between systems, someone finds out late, usually at invoicing. Nobody can say which record is right, or who decided.

## What people do today (assumed)

1. A consultant copies a new client from the CRM into a case tracker.
2. Finance compares CRM and ERP exports by eye once a month.
3. A reviewer reads each document by hand to find missing fields.
4. Someone emails the team when a case is approved.
5. A manager rebuilds the status report from all of the above.

## What changes

1. New clients arrive through a repeatable sync, and repeating it creates no duplicates.
2. Mismatches appear as findings that show both values and their timestamps. A person approves, rejects or defers each one.
3. AI reads a document and proposes fields with the source location beside each. It can abstain. It can't change a record.
4. An approval writes the state change, audit entry and notification event together, or not at all. Notifications are retried and never sent twice under the failures we test.
5. The dashboard shows counts tied to real records, and marks every number as synthetic, measured or estimated.

## Who it's for

| Audience | What they care about |
|---|---|
| Operations analyst | A queue that says what to do next and why |
| Finance | One defensible answer to "who is the customer?" |
| Manager | Bottlenecks and honest assumptions |
| Interviewer | One link, five minutes, no signup, clear labels |

## Risks

- Everything public is simulated or synthetic, and the app says so on the screen.
- A free database sleeps, so the first visitor waits a few seconds. The app says that too.
- ROI figures are illustrative projections and never claims of real savings.

## Success at the end of v1

A first-time visitor finishes the guided story in five minutes, with no account, and can see exactly what was real and what was simulated.
