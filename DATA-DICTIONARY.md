# Data dictionary

Business terms, their source meaning and how they map to the canonical model. Northstar Operations and every department here are fictional. Business stewards are fictional roles.

| Term | CRM meaning | ERP meaning | Canonical meaning | Transformation | Steward | Conflict rule |
|---|---|---|---|---|---|---|
| Customer | Account or prospect, may have no contract | Billable legal entity. The ERP record type also holds leads and prospects, told apart by its stage | An organization Northstar serves, in `customers` | Linked by `customer_source_relationships`, never by merging | Finance lead | ERP wins on legal name and billing; CRM wins on sales stage; a person decides anything else |
| Billing entity | Not modeled | Customer record with stage CUSTOMER; `parent` shows a sub-customer | A source identity under one customer | One organization may have many | Finance lead | Related, not interchangeable; never auto-merged |
| Consultant case | Not modeled | Not modeled | Unit of work in `cases` | Native to OpsBridge | Operations lead | OpsBridge is the authority |
| Invoice | Not modeled | Transaction of type `CustInvc`; `entity` is its bill-to | Read-only reference with `bill_to` | Keeps its specific bill-to link | Finance lead | Unknown client opens a finding |
| Inventory item | Not modeled | Item record | `inventory_items`, stable code and unit | Exact code match only | Operations lead | Unknown code opens a finding |
| Quantity | Not modeled | On-hand figure | Read-only fact in `inventory_snapshots` | No unit conversion | Operations lead | Newest source version wins; older is recorded as stale |
| Unit | Not modeled | Unit of measure | Canonical unit on the item | No silent conversion | Operations lead | Mismatch opens a finding |
| Source freshness | Last modified | Last modified | Time since `observed_at` of the last successful sync | Computed | Integration owner | Shown on every view |
| Lifecycle status | Stage field | Stage field, plus an inactive flag | `customers.lifecycle_status` | Mapped through `source_definition_mappings` | Sales and finance | Mapping version recorded |

## Worked definition mismatch

This is the showcase case, in `tests/integration/reconciliation.test.ts`.

*Harbor Ridge Produce LLC (fictional)* is one CRM account. The ERP Simulator has two customer records for it, Harbor Ridge Holdings Inc. and Harbor Ridge Packing LLC, both fictional, and both carry an exact cross-reference to that CRM account in `custentity_ob_crm_account_id`. All three records are correct. The word "customer" means different things in each system:

| | CRM | ERP | Canonical |
|---|---|---|---|
| A customer is | An organization in the sales relationship, prospect included | A billable legal entity under a subsidiary, one per bill-to | An organization Northstar serves |
| Harbor Ridge counts as | 1 | 2 | 1 |

A spelling comparison would call the two bill-tos duplicates, and merging them would lose the bill-to on every invoice. So the system raises a `definition_conflict` with the evidence and rule R-CUST-1. A reviewer approves the mapping once: one canonical customer, two source relationships, a `source_definition_mappings` row, and each invoice keeps its own `bill_to_external_id`. Replaying the same snapshot leaves all of that alone (JOB-TEST-01, P3-H).

The reverse case sits beside it. *Tall Pine Nursery (fictional)* is a CRM prospect with no ERP record, so the CRM counts a customer the ERP has never heard of. A sync raises a low-severity finding, and nothing is created without a person.

## Business rules

| Rule | Statement |
|---|---|
| R-CUST-1 | A CRM account and an ERP customer record are different things. One organization may have many bill-tos. They are mapped, never merged. |
| R-CUST-2 | The ERP has authority over legal name and account number. A difference opens a finding, and a person approves the change. |
| R-CUST-3 | A matching normalized name is a reason to look, never a reason to link. |
| R-CUST-4 | A record missing from a source read changes nothing here. The last values stay and a person is told. |
| R-INV-1 | Quantities are read-only source facts. No conversion, no writeback, no invented items. |

The dictionary is also code, in `backend/src/domain/glossary.ts`, served at `GET /api/v1/reconciliation/definitions`. A test holds the two together.

## Delivery vocabulary

| Label | Meaning |
|---|---|
| Queued | Waiting, sending or waiting to retry |
| Accepted | The provider took it; nothing proves a person got it |
| Confirmed | Evidence exists and is linked |
| Failed | Retries exhausted, or a permanent error |
| Simulated | No external system was involved |

Derivation from `dispatch_state` and `delivery_evidence` is in PRD 7.2.

## Metric provenance

`SYNTHETIC`, `MEASURED_DEMO`, `ESTIMATED`, `UNKNOWN` (PRD 11.2). Every metric response carries one.
