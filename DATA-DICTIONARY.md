# Data dictionary

Business terms, their source meaning and how they map to the canonical model. Northstar Operations and every department here are fictional. Business stewards are fictional roles.

| Term | CRM meaning | ERP meaning | Canonical meaning | Transformation | Steward | Conflict rule |
|---|---|---|---|---|---|---|
| Customer | Account or prospect, may have no contract | Billable legal entity | An organization Northstar serves, in `customers` | Linked by `customer_source_relationships`, never by merging | Finance lead | ERP wins on legal name and billing; CRM wins on sales stage; a person decides anything else |
| Billing entity | Not modeled | Bill-to record | A source identity under one customer | One organization may have many | Finance lead | Related, not interchangeable; never auto-merged |
| Consultant case | Not modeled | Not modeled | Unit of work in `cases` | Native to OpsBridge | Operations lead | OpsBridge is the authority |
| Invoice | Not modeled | Invoice record | Read-only reference with `bill_to` | Keeps its specific bill-to link | Finance lead | Unknown client opens a finding |
| Inventory item | Not modeled | Item record | `inventory_items`, stable code and unit | Exact code match only | Operations lead | Unknown code opens a finding |
| Quantity | Not modeled | On-hand figure | Read-only fact in `inventory_snapshots` | No unit conversion | Operations lead | Newest source version wins; older is recorded as stale |
| Unit | Not modeled | Unit of measure | Canonical unit on the item | No silent conversion | Operations lead | Mismatch opens a finding |
| Source freshness | Last modified | Last modified | Time since `observed_at` of the last successful sync | Computed | Integration owner | Shown on every view |
| Lifecycle status | Stage field | Active flag | `customers.lifecycle_status` | Mapped through `source_definition_mappings` | Sales and finance | Mapping version recorded |

## Worked definition mismatch

*Harbor Ridge Produce LLC (fictional)* is one CRM organization. The ERP has two bill-to entities for it: Harbor Ridge Holdings Inc. and Harbor Ridge Packing LLC, both fictional. Both are correct. A spelling comparison would call them duplicates. The canonical model keeps one customer with two source relationships, and each invoice keeps its own bill-to. A reviewer approves the mapping once, and replaying the same snapshots leaves it alone (JOB-TEST-01, P3-H).

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
