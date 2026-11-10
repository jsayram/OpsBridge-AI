// The business dictionary as data, so the app and DATA-DICTIONARY.md can be checked against each
// other. Stewards are fictional roles.
export type GlossaryTerm = {
  term: string;
  crm: string;
  erp: string;
  canonical: string;
  transformation: string;
  steward: string;
  conflictRule: string;
};

export const GLOSSARY: readonly GlossaryTerm[] = [
  {
    term: "Customer",
    crm: "Account: an organization in the sales relationship, prospect or customer, possibly with no contract",
    erp: "Customer record: a billable legal entity under a subsidiary. The same record type also holds leads and prospects, told apart by its stage",
    canonical: "An organization Northstar serves, one row in customers",
    transformation: "Linked by customer_source_relationships, never by merging",
    steward: "Finance lead",
    conflictRule:
      "ERP wins on legal name and billing, CRM wins on sales stage, a person decides the rest",
  },
  {
    term: "Billing entity",
    crm: "Not modeled",
    erp: "A customer record with stage CUSTOMER; a sub-customer's parent shows the hierarchy",
    canonical: "A source identity under one customer; one organization may have many",
    transformation: "One source relationship per bill-to",
    steward: "Finance lead",
    conflictRule: "Related, not interchangeable; never auto-merged",
  },
  {
    term: "Consultant case",
    crm: "Not modeled",
    erp: "Not modeled",
    canonical: "A unit of work in cases",
    transformation: "Native to OpsBridge",
    steward: "Operations lead",
    conflictRule: "OpsBridge is the authority",
  },
  {
    term: "Invoice",
    crm: "Not modeled",
    erp: "Transaction of type CustInvc, entity is its bill-to",
    canonical: "A read-only reference that keeps its own bill_to_external_id",
    transformation: "Customer filled in only through an approved link",
    steward: "Finance lead",
    conflictRule: "Unknown client opens a finding",
  },
  {
    term: "Inventory item",
    crm: "Not modeled",
    erp: "Item record",
    canonical: "inventory_items, with a stable code and unit",
    transformation: "Exact code match only",
    steward: "Operations lead",
    conflictRule: "Unknown code opens a finding",
  },
  {
    term: "Quantity",
    crm: "Not modeled",
    erp: "On-hand figure",
    canonical: "A read-only fact in inventory_snapshots",
    transformation: "No unit conversion",
    steward: "Operations lead",
    conflictRule: "Newest source version wins; older is recorded as stale",
  },
  {
    term: "Unit",
    crm: "Not modeled",
    erp: "Unit of measure",
    canonical: "The canonical unit on the item",
    transformation: "No silent conversion",
    steward: "Operations lead",
    conflictRule: "Mismatch opens a finding",
  },
  {
    term: "Source freshness",
    crm: "Last modified",
    erp: "Last modified",
    canonical: "Time since the last successful sync",
    transformation: "Computed",
    steward: "Integration owner",
    conflictRule: "Shown on every view",
  },
  {
    term: "Lifecycle status",
    crm: "Stage field",
    erp: "Stage field, lead, prospect or customer, plus an inactive flag",
    canonical: "customers.lifecycle_status",
    transformation: "Mapped through source_definition_mappings",
    steward: "Sales and finance",
    conflictRule: "Mapping version recorded",
  },
];

export const RULES = {
  "R-CUST-1":
    "A CRM account and an ERP customer record are different things. One organization may have many bill-tos. They are mapped, never merged.",
  "R-CUST-2":
    "The ERP has authority over legal name and account number. A difference opens a finding, and a person approves the change.",
  "R-CUST-3": "A matching normalized name is a reason to look, never a reason to link.",
  "R-CUST-4":
    "A record missing from a source read changes nothing here. The last values stay and a person is told.",
  "R-INV-1":
    "Quantities are read-only source facts. No conversion, no writeback, no invented items.",
} as const;
