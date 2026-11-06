// The matching rules, as a pure function. It can only describe findings and exact-ID links; it
// has no way to change a record. Order of trust: stable IDs first, then normalized names, which
// may only suggest a human look. There is no similarity score anywhere in this file, so a fuzzy
// merge has no code path (P3-F). No value import from another project file, because the seed
// generator runs this under plain Node.

export const NORMALIZATION_VERSION = "name-norm-1";
export const STALE_AFTER_DAYS = 7;
export const CANONICAL_UNITS = ["each", "box", "case", "kg", "litre"] as const;

export type FindingKind =
  | "definition_conflict"
  | "name_mismatch"
  | "account_mismatch"
  | "duplicate_client"
  | "missing_client"
  | "source_deleted"
  | "unknown_sku"
  | "unit_mismatch"
  | "invalid_unit"
  | "stale_snapshot";

export type SourceFact = {
  provider: string;
  externalType: string;
  externalId: string;
  sourceModifiedAt: string;
  externalVersion: string;
  state: "active" | "deleted";
  data: Record<string, unknown>;
};
export type CustomerFact = {
  id: string;
  canonicalName: string;
  accountCode: string;
  lifecycleStatus: string;
};
export type LinkFact = {
  provider: string;
  externalType: string;
  externalId: string;
  canonicalId: string;
};
export type ItemFact = { id: string; code: string; canonicalUnit: string };
export type SnapshotFact = {
  externalId: string;
  itemCode: string | null;
  itemId: string | null;
  quantity: string;
  unit: string;
  sourceVersion: number;
  observedAt: string;
  location: string | null;
};

export type EvidenceSource = {
  system: string;
  recordType: string;
  externalId: string;
  sourceTimestamp: string;
  externalVersion: string;
  fields: Record<string, string | null>;
};

export type Resolution =
  | { type: "link_bill_tos"; externalIds: string[]; ruleRef: string }
  | { type: "set_canonical_name"; externalId: string; from: string; to: string }
  | { type: "set_account_code"; externalId: string; from: string; to: string }
  | {
      type: "link_or_create";
      provider: string;
      externalType: string;
      externalId: string;
      name: string;
      lifecycle: "Prospect" | "Active";
      accountCode: string;
      suggestedCustomerId: string | null;
    }
  | { type: "acknowledge" };

export type Evidence = {
  sources: EvidenceSource[];
  differences: { field: string; values: Record<string, string | null>; normalizedEqual: boolean }[];
  matchBasis: "exact_id" | "normalized_name" | "none";
  explanation: string;
  recommendedAction: string;
  ruleRef: string | null;
  normalization: string;
  resolution: Resolution;
};

export type DetectedFinding = {
  kind: FindingKind;
  severity: "low" | "medium" | "high";
  entityType: "customer" | "inventory_item" | "source_record";
  entityId: string | null;
  subject: string;
  dedupeKey: string;
  evidence: Evidence;
};
export type ExactLink = {
  provider: string;
  externalType: string;
  externalId: string;
  customerId: string;
};

export type DetectInput = {
  now: string;
  sources: SourceFact[];
  customers: CustomerFact[];
  links: LinkFact[];
  items: ItemFact[];
  snapshots: SnapshotFact[];
};

const LEGAL_SUFFIX = /\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited)\b/g;

// Deterministic and explainable: case, punctuation, legal suffix and the fixture marker. Two
// names that differ after this are different names, however similar they look.
export const normalizeName = (name: string) =>
  name
    .toLowerCase()
    .replace(/\(fictional\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();

// Not a security hash. It only has to give the same short key on both sides of a replay, and
// run synchronously in the Worker and in the seed generator.
export function fingerprint(input: string): string {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(b) + hex(a);
}

// Timestamps stay out on purpose: the same facts seen later are the same finding.
export const findingKey = (
  kind: FindingKind,
  subject: string,
  values: Record<string, string | null>,
) => {
  const stable = Object.keys(values)
    .sort()
    .map((k) => [k, values[k]]);
  return `${kind}:${subject}:${fingerprint(JSON.stringify(stable))}`;
};

const label = (provider: string) =>
  provider === "salesforce_test"
    ? "Salesforce test org"
    : provider === "crm_simulator"
      ? "CRM (simulated)"
      : provider === "erp_simulator"
        ? "ERP Simulator"
        : "Inventory (simulated)";

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

const cite = (s: SourceFact, fields: Record<string, string | null>): EvidenceSource => ({
  system: label(s.provider),
  recordType: s.externalType,
  externalId: s.externalId,
  sourceTimestamp: s.sourceModifiedAt,
  externalVersion: s.externalVersion,
  fields,
});

const erpFields = (s: SourceFact) => ({
  companyname: str(s.data.name),
  entityid: str(s.data.entityId),
  stage: str(s.data.stage),
  parent: str(s.data.parent),
  accountnumber: str(s.data.accountNumber),
  crmAccountRef: str(s.data.crmAccountId),
});
const crmFields = (s: SourceFact) => ({
  Name: str(s.data.name),
  Type: str(s.data.crmType),
  AccountNumber: str(s.data.accountNumber),
});

export function detectFindings(input: DetectInput): {
  findings: DetectedFinding[];
  exactLinks: ExactLink[];
} {
  const findings: DetectedFinding[] = [];
  const exactLinks: ExactLink[] = [];
  const linkKey = (provider: string, type: string, id: string) => `${provider}|${type}|${id}`;
  const links = new Map(
    input.links.map((l) => [linkKey(l.provider, l.externalType, l.externalId), l.canonicalId]),
  );
  const customers = new Map(input.customers.map((c) => [c.id, c]));
  const active = input.sources.filter((s) => s.state === "active");
  const crm = active.filter((s) => s.externalType === "organization");
  const erp = active.filter((s) => s.provider === "erp_simulator" && s.externalType === "customer");
  const crmById = new Map(crm.map((s) => [s.externalId, s]));
  const linkOf = (s: SourceFact) => links.get(linkKey(s.provider, s.externalType, s.externalId));
  const newCustomer = (s: SourceFact, code: string, lifecycle: "Prospect" | "Active") => ({
    type: "link_or_create" as const,
    provider: s.provider,
    externalType: s.externalType,
    externalId: s.externalId,
    name: str(s.data.name) ?? s.externalId,
    lifecycle,
    accountCode: code,
    suggestedCustomerId: null,
  });

  // CRM organizations nobody has mapped yet. A prospect is a real CRM "customer" with no billing
  // identity, which is the first half of the definition gap.
  for (const org of crm) {
    if (linkOf(org)) continue;
    const name = str(org.data.name) ?? "";
    const subject = `crm:${org.externalId}`;
    findings.push({
      kind: "missing_client",
      severity: "low",
      entityType: "source_record",
      entityId: null,
      subject,
      dedupeKey: findingKey("missing_client", subject, { name }),
      evidence: {
        sources: [cite(org, crmFields(org))],
        differences: [],
        matchBasis: "none",
        explanation:
          "The CRM holds this organization and no canonical customer is mapped to it. A CRM account can be a prospect with no contract, so nothing is created on its own.",
        recommendedAction:
          "Create a canonical prospect, link it to an existing customer, or reject.",
        ruleRef: "R-CUST-1",
        normalization: NORMALIZATION_VERSION,
        resolution: newCustomer(
          org,
          str(org.data.accountNumber) ?? `CRM-${org.externalId.slice(-12)}`,
          "Prospect",
        ),
      },
    });
  }

  // Exact cross-reference from ERP to CRM. Bill-tos that share one CRM organization are the
  // definition conflict: they are related, and they are not the same thing.
  const byCrmRef = new Map<string, SourceFact[]>();
  for (const c of erp) {
    const ref = str(c.data.crmAccountId);
    if (ref && !linkOf(c)) byCrmRef.set(ref, [...(byCrmRef.get(ref) ?? []), c]);
  }
  for (const [ref, billTos] of byCrmRef) {
    const org = crmById.get(ref);
    const customerId =
      links.get(linkKey("crm_simulator", "organization", ref)) ??
      links.get(linkKey("salesforce_test", "organization", ref));
    if (!customerId) continue; // Reported below as an ERP record with no customer.
    const sorted = [...billTos].sort((x, y) => x.externalId.localeCompare(y.externalId));
    const existing = input.links.some(
      (l) =>
        l.provider === "erp_simulator" &&
        l.externalType === "customer" &&
        l.canonicalId === customerId,
    );
    const first = sorted[0] as SourceFact;
    if (sorted.length === 1 && !existing) {
      exactLinks.push({
        provider: first.provider,
        externalType: first.externalType,
        externalId: first.externalId,
        customerId,
      });
      continue;
    }
    const customer = customers.get(customerId);
    const subject = `crm:${ref}`;
    const crmName = org ? str(org.data.name) : (customer?.canonicalName ?? null);
    const billToList = sorted.map((b) => `${b.externalId}=${str(b.data.name)}`).join("|");
    findings.push({
      kind: "definition_conflict",
      severity: "high",
      entityType: "customer",
      entityId: customerId,
      subject,
      dedupeKey: findingKey("definition_conflict", subject, { crmName, billTos: billToList }),
      evidence: {
        sources: [
          ...(org ? [cite(org, crmFields(org))] : []),
          ...sorted.map((b) => cite(b, erpFields(b))),
        ],
        differences: [
          {
            field: "customer definition",
            values: {
              crm: "Account: an organization in the sales relationship, prospect or customer",
              erp: "Customer record: a billable legal entity under a subsidiary, one per bill-to",
            },
            normalizedEqual: false,
          },
        ],
        matchBasis: "exact_id",
        explanation: `${sorted.length} ERP customer records carry an exact cross-reference to one CRM account. Both sources are right: the CRM counts one organization and the ERP counts ${sorted.length} billable entities. A spelling comparison would call them duplicates, and merging would lose the bill-to on every invoice.`,
        recommendedAction:
          "Approve the mapping: keep one canonical customer, add each bill-to as its own source relationship, and keep invoices on their own bill-to.",
        ruleRef: "R-CUST-1",
        normalization: NORMALIZATION_VERSION,
        resolution: {
          type: "link_bill_tos",
          externalIds: sorted.map((b) => b.externalId),
          ruleRef: "R-CUST-1",
        },
      },
    });
  }

  // ERP records with a mapped customer: compare the fields the ERP has authority over.
  const erpLinkCount = new Map<string, number>();
  for (const l of input.links) {
    if (l.provider === "erp_simulator" && l.externalType === "customer") {
      erpLinkCount.set(l.canonicalId, (erpLinkCount.get(l.canonicalId) ?? 0) + 1);
    }
  }
  for (const c of erp) {
    const customerId = linkOf(c);
    if (!customerId) continue;
    const customer = customers.get(customerId);
    if (!customer) continue;
    const singleBillTo = erpLinkCount.get(customerId) === 1;
    const name = str(c.data.name) ?? "";
    const subject = `erp:customer:${c.externalId}`;
    if (singleBillTo && name !== customer.canonicalName) {
      const same = normalizeName(name) === normalizeName(customer.canonicalName);
      findings.push({
        kind: "name_mismatch",
        severity: same ? "low" : "medium",
        entityType: "customer",
        entityId: customerId,
        subject,
        dedupeKey: findingKey("name_mismatch", subject, {
          canonical: customer.canonicalName,
          erp: name,
        }),
        evidence: {
          sources: [cite(c, erpFields(c))],
          differences: [
            {
              field: "name",
              values: { canonical: customer.canonicalName, erp: name },
              normalizedEqual: same,
            },
          ],
          matchBasis: "exact_id",
          explanation: same
            ? "Matched on the exact ERP ID. The names differ only in punctuation or legal suffix, and the ERP owns the legal name."
            : "Matched on the exact ERP ID, and the name changed in substance. This may be a rename, so a person confirms it.",
          recommendedAction:
            "Approve to take the ERP legal name, or reject to keep the current name.",
          ruleRef: "R-CUST-2",
          normalization: NORMALIZATION_VERSION,
          resolution: {
            type: "set_canonical_name",
            externalId: c.externalId,
            from: customer.canonicalName,
            to: name,
          },
        },
      });
    }
    const account = str(c.data.accountNumber);
    if (account && account !== customer.accountCode) {
      const accountSubject = `erp:account:${c.externalId}`;
      findings.push({
        kind: "account_mismatch",
        severity: "high",
        entityType: "customer",
        entityId: customerId,
        subject: accountSubject,
        dedupeKey: findingKey("account_mismatch", accountSubject, {
          canonical: customer.accountCode,
          erp: account,
        }),
        evidence: {
          sources: [cite(c, erpFields(c))],
          differences: [
            {
              field: "account",
              values: { canonical: customer.accountCode, erp: account },
              normalizedEqual: false,
            },
          ],
          matchBasis: "exact_id",
          explanation:
            "The stable ERP ID matches this customer, but its account number does not. Billing could post to the wrong account.",
          recommendedAction: "Check with finance, then approve the ERP account or reject.",
          ruleRef: "R-CUST-2",
          normalization: NORMALIZATION_VERSION,
          resolution: {
            type: "set_account_code",
            externalId: c.externalId,
            from: customer.accountCode,
            to: account,
          },
        },
      });
    }
  }

  // ERP records with neither a link nor a usable cross-reference.
  const canonicalByName = new Map(
    input.customers.map((c) => [normalizeName(c.canonicalName), c] as const),
  );
  for (const c of erp) {
    if (linkOf(c)) continue;
    const ref = str(c.data.crmAccountId);
    const refMapped =
      ref &&
      (links.has(linkKey("crm_simulator", "organization", ref)) ||
        links.has(linkKey("salesforce_test", "organization", ref)));
    if (refMapped) continue;
    const name = str(c.data.name) ?? "";
    const subject = `erp:customer:${c.externalId}`;
    const normalized = normalizeName(name);
    const twin = erp.find(
      (o) => o !== c && linkOf(o) && normalizeName(str(o.data.name) ?? "") === normalized,
    );
    const candidate = canonicalByName.get(normalized);
    const suggestion = twin ? linkOf(twin) : candidate?.id;
    const code = str(c.data.accountNumber) ?? `ERP-${c.externalId}`;
    if (suggestion) {
      findings.push({
        kind: "duplicate_client",
        severity: "medium",
        entityType: "customer",
        entityId: suggestion,
        subject,
        dedupeKey: findingKey("duplicate_client", subject, { name, normalized }),
        evidence: {
          sources: [cite(c, erpFields(c)), ...(twin ? [cite(twin, erpFields(twin))] : [])],
          differences: [
            {
              field: "external ID",
              values: {
                existing: twin?.externalId ?? candidate?.canonicalName ?? null,
                incoming: c.externalId,
              },
              normalizedEqual: true,
            },
          ],
          matchBasis: "normalized_name",
          explanation:
            "This ERP record has its own ID and the same normalized name as a known customer. A matching name is a reason to look, never a reason to merge.",
          recommendedAction:
            "Link it to the suggested customer only if finance confirms it is the same entity. Otherwise reject.",
          ruleRef: "R-CUST-3",
          normalization: NORMALIZATION_VERSION,
          resolution: {
            ...newCustomer(c, code, "Active"),
            suggestedCustomerId: suggestion ?? null,
          },
        },
      });
    } else {
      findings.push({
        kind: "missing_client",
        severity: "medium",
        entityType: "source_record",
        entityId: null,
        subject,
        dedupeKey: findingKey("missing_client", subject, { name }),
        evidence: {
          sources: [cite(c, erpFields(c))],
          differences: [],
          matchBasis: "none",
          explanation:
            "The ERP bills this entity and no canonical customer is mapped to it, so its invoices have no client here.",
          recommendedAction: "Create a canonical customer, link it to an existing one, or reject.",
          ruleRef: "R-CUST-1",
          normalization: NORMALIZATION_VERSION,
          resolution: newCustomer(c, code, "Active"),
        },
      });
    }
  }

  // A mapped record that vanished from a complete source read. Evidence only: nothing canonical
  // is deleted because a source stopped returning a row.
  for (const s of input.sources) {
    const customerId = s.state === "deleted" ? linkOf(s) : undefined;
    if (!customerId) continue;
    const subject = `deleted:${s.provider}:${s.externalType}:${s.externalId}`;
    findings.push({
      kind: "source_deleted",
      severity: "medium",
      entityType: "customer",
      entityId: customerId,
      subject,
      dedupeKey: findingKey("source_deleted", subject, { version: s.externalVersion }),
      evidence: {
        sources: [cite(s, { name: str(s.data.name) })],
        differences: [],
        matchBasis: "exact_id",
        explanation:
          "A complete read of the source no longer returned this mapped record. The canonical customer and the last source values stay as they were.",
        recommendedAction: "Find out why it went away. Approving records that you reviewed it.",
        ruleRef: "R-CUST-4",
        normalization: NORMALIZATION_VERSION,
        resolution: { type: "acknowledge" },
      },
    });
  }

  // Inventory. Newest version per source record; quantities are never changed or converted.
  const newest = new Map<string, SnapshotFact>();
  for (const s of input.snapshots) {
    const held = newest.get(s.externalId);
    if (!held || s.sourceVersion > held.sourceVersion) newest.set(s.externalId, s);
  }
  const items = new Map(input.items.map((i) => [i.id, i]));
  const staleBefore = Date.parse(input.now) - STALE_AFTER_DAYS * 86_400_000;
  for (const s of newest.values()) {
    const item = s.itemId ? items.get(s.itemId) : undefined;
    const source: EvidenceSource = {
      system: label("inventory_simulator"),
      recordType: "inventory_snapshot",
      externalId: s.externalId,
      sourceTimestamp: s.observedAt,
      externalVersion: String(s.sourceVersion),
      fields: {
        itemCode: s.itemCode,
        quantity: s.quantity,
        unit: s.unit,
        location: s.location,
      },
    };
    const inventory = (
      kind: FindingKind,
      severity: "low" | "medium" | "high",
      values: Record<string, string | null>,
      explanation: string,
      recommendedAction: string,
      differences: Evidence["differences"] = [],
    ) => {
      const subject = `inventory:${kind}:${s.externalId}`;
      findings.push({
        kind,
        severity,
        entityType: item ? "inventory_item" : "source_record",
        entityId: item?.id ?? null,
        subject,
        dedupeKey: findingKey(kind, subject, values),
        evidence: {
          sources: [source],
          differences,
          matchBasis: item ? "exact_id" : "none",
          explanation,
          recommendedAction,
          ruleRef: "R-INV-1",
          normalization: NORMALIZATION_VERSION,
          resolution: { type: "acknowledge" },
        },
      });
    };
    if (!item) {
      inventory(
        "unknown_sku",
        "medium",
        { itemCode: s.itemCode },
        "No canonical item has this exact code. The source fact is kept and no item is invented.",
        "Add the item through its owner or correct the code at the source, then approve to record the review.",
      );
      continue;
    }
    if (!(CANONICAL_UNITS as readonly string[]).includes(s.unit)) {
      inventory(
        "invalid_unit",
        "medium",
        { itemCode: item.code, unit: s.unit },
        `"${s.unit}" is not a unit OpsBridge defines, so this quantity can't be compared with stock in ${item.canonicalUnit}.`,
        "Correct the unit at the source. Approving records the review and changes no quantity.",
      );
    } else if (s.unit !== item.canonicalUnit) {
      inventory(
        "unit_mismatch",
        "high",
        { itemCode: item.code, unit: s.unit, canonicalUnit: item.canonicalUnit },
        "The source reports a different unit from the canonical item. No conversion factor is defined, so none is applied.",
        "Confirm the right unit with the item owner. Approving records the review and changes no quantity.",
        [
          {
            field: "unit",
            values: { canonical: item.canonicalUnit, source: s.unit },
            normalizedEqual: false,
          },
        ],
      );
    }
    if (Date.parse(s.observedAt) < staleBefore) {
      inventory(
        "stale_snapshot",
        "low",
        { itemCode: item.code, version: String(s.sourceVersion) },
        `The newest source version is more than ${STALE_AFTER_DAYS} days old, so this quantity may not reflect the shelf.`,
        "Ask the source owner for a fresh count. Approving records the review and changes no quantity.",
      );
    }
  }

  return { findings, exactLinks };
}
