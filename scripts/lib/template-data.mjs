// Deterministic template dataset: same manifest, same records, same IDs and dates. Contacts,
// invoices and dashboard snapshots wait for their tables in P3 and P6.
import { createHash } from "node:crypto";

export const TEMPLATE_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export const OWNER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
export const OWNER_CUSTOMER_ID = "00000000-0000-4000-8000-000000000003";
export const OWNER_CASE_ID = "00000000-0000-4000-8000-000000000004";
export const OWNER_ASSIGNEE_ID = "00000000-0000-4000-8000-000000000005";

const stableId = (seed, key) => {
  const h = createHash("sha256").update(`${seed}:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const DAY = 86_400_000;
const CASE_TYPES = ["Onboarding", "Billing", "Renewal", "Field issue"];
const SUBJECTS = [
  "Seasonal crew onboarding",
  "Billing entity review",
  "Contract renewal check",
  "Site access checklist",
  "Timesheet mismatch",
  "Equipment handoff",
];

// Fixture F6 runs through these three: two people who can hold a case, one who can't.
const ASSIGNEES = [
  ["Dana Okafor (fictional)", "Field Services", true],
  ["Marcus Vale (fictional)", "Seasonal Staffing", true],
  ["Rae Lindqvist, observer (fictional)", "Field Services", false],
];

// Pack checklists. Case 1 can't leave Intake yet, case 2 has a flagged item (F6), case 3 is clear.
const PACK_CHECKLISTS = {
  "case-1": [
    ["client_contact_confirmed", "Client contact confirmed", true, "open"],
    ["scope_confirmed", "Scope of work confirmed", true, "open"],
    ["site_access_noted", "Site access noted", false, "open"],
  ],
  "case-2": [
    ["client_contact_confirmed", "Client contact confirmed", true, "done"],
    ["billing_entity_confirmed", "Billing entity confirmed", true, "flagged"],
    ["site_access_noted", "Site access noted", false, "not_applicable"],
  ],
  "case-3": [
    ["client_contact_confirmed", "Client contact confirmed", true, "done"],
    ["renewal_terms_confirmed", "Renewal terms confirmed", true, "done"],
  ],
};

const FINDING_KINDS = [
  "name_mismatch",
  "duplicate_client",
  "missing_client",
  "bill_to_review",
  "unit_mismatch",
  "stale_snapshot",
  "unknown_sku",
];
const SEVERITIES = ["high", "medium", "low"];
const PACK_FINDING_STATUS = ["Open", "Investigating", "Proposed"];
const TEMPLATE_FINDING_STATUS = ["Open", "Investigating", "Proposed", "Resolved", "Dismissed"];

const AUTOMATION_LABELS = {
  Confirmed: { dispatch_state: "accepted", delivery_evidence: "confirmed" },
  Accepted: { dispatch_state: "accepted", delivery_evidence: "provider_accepted" },
  Simulated: { dispatch_state: "simulated", delivery_evidence: "none" },
  Queued: { dispatch_state: "pending", delivery_evidence: "none" },
  Failed: { dispatch_state: "dead_letter", delivery_evidence: "none" },
};

export const caseRefFor = (id) =>
  `CASE-${createHash("sha256").update(id).digest("hex").slice(0, 8).toUpperCase()}`;

export function buildTemplate(manifest) {
  const seed = manifest.randomSeed;
  const clock = Date.parse(manifest.clock);
  const at = (days) => new Date(clock + days * DAY).toISOString();
  const id = (key) => stableId(seed, key);

  const customers = manifest.organizationNames.map((name, i) => ({
    id: id(`customer:${i}`),
    canonical_name: name,
    account_code: `NS-${String(1001 + i)}`,
    lifecycle_status: i === 5 ? "Prospect" : "Active",
    pack_key: i < 2 ? `customer-${i + 1}` : null,
  }));

  const assignees = ASSIGNEES.map(([display_name, team, can_receive_cases], i) => ({
    id: id(`assignee:${i}`),
    display_name,
    team,
    can_receive_cases,
    pack_key: `assignee-${i + 1}`,
  }));

  const packStatuses = ["Intake", "Needs Review", "Ready"];
  const cases = [];
  let n = 0;
  for (const [status, count] of Object.entries(manifest.template.cases.byStatus)) {
    for (let i = 0; i < count; i++, n++) {
      const packIndex = i === 0 ? packStatuses.indexOf(status) : -1;
      const customer = packIndex >= 0 ? customers[packIndex % 2] : customers[n % customers.length];
      const assignee =
        packIndex >= 0 ? assignees[packIndex === 2 ? 1 : 0] : n % 3 ? assignees[n % 2] : null;
      cases.push({
        id: id(`case:${n}`),
        customer_id: customer.id,
        title: `${SUBJECTS[n % SUBJECTS.length]} ${String(n + 1).padStart(3, "0")}`,
        case_type: CASE_TYPES[n % CASE_TYPES.length],
        status,
        due_at: at((n % 21) - 7),
        created_at: at(-30 + (n % 28)),
        queue: assignee?.team ?? manifest.template.teams[n % 2],
        assignee_id: assignee?.id ?? null,
        pack_key: packIndex >= 0 ? `case-${packIndex + 1}` : null,
      });
    }
  }
  const packCases = cases.filter((c) => c.pack_key);

  const checklist = packCases.flatMap((c) =>
    PACK_CHECKLISTS[c.pack_key].map(([item_key, label, required, state], position) => ({
      id: id(`checklist:${c.pack_key}:${item_key}`),
      case_id: c.id,
      item_key,
      label,
      position,
      required,
      state,
    })),
  );

  // The invariant holds across the template too: every Ready case has one pending approval.
  const approvals = cases
    .filter((c) => c.status === "Ready")
    .map((c) => ({
      id: id(`approval:${c.id}`),
      case_id: c.id,
      proposed_action: "approve_case",
      proposed_payload: JSON.stringify({ title: c.title }),
      status: "pending",
      requested_by: "seed",
      created_at: at(-1),
    }));

  const docCats = manifest.template.documents;
  const categories = ["standard", "messy", "adversarial"].flatMap((cat) =>
    Array.from({ length: docCats[cat] }, () => cat),
  );
  const documents = categories.map((category, i) => {
    const packCase = packCases[i];
    return {
      id: id(`document:${i}`),
      case_id: (packCase ?? cases[i % cases.length]).id,
      title: `Intake sheet ${String(i + 1).padStart(2, "0")} (synthetic)`,
      fixture_id: `fx-${category}-${String(i + 1).padStart(2, "0")}`,
      category,
      status: "Pending",
      created_at: at(-10),
      pack_key: packCase ? `document-${i + 1}` : null,
    };
  });

  const ai_reviews = [
    {
      id: id("ai-review:0"),
      document_id: documents[0].id,
      model_version: "fixture",
      prompt_version: "fixture-1",
      extraction: JSON.stringify({ missingFields: ["signed_scope", "billing_contact"] }),
      citations: JSON.stringify([{ field: "signed_scope", page: 1 }]),
      status: "Needs Human Review",
      abstain_reason: null,
    },
  ];

  // F1: one CRM organization, two legitimate ERP bill-tos, and one ERP spelling difference.
  const [c1, c2] = customers;
  const links = [
    ["link-1", "crm_simulator", "organization", "CRM-ORG-1001", c1],
    ["link-2", "erp_simulator", "bill_to", "ERP-BT-5001", c1],
    ["link-3", "erp_simulator", "bill_to", "ERP-BT-5002", c1],
    ["link-4", "erp_simulator", "bill_to", "ERP-BT-6001", c2],
  ].map(([pack_key, provider, external_type, external_id, customer]) => ({
    id: id(`link:${pack_key}`),
    provider,
    external_type,
    external_id,
    canonical_type: "customer",
    canonical_id: customer.id,
    last_seen: at(-1),
    pack_key,
  }));
  const relationships = links.slice(1).map((l) => ({
    id: id(`relationship:${l.pack_key}`),
    customer_id: l.canonical_id,
    external_record_link_id: l.id,
    relationship_role: "erp_bill_to",
    mapping_version: "map-1",
    approved_by: "seed",
    approved_at: at(-20),
  }));

  const findings = Array.from({ length: manifest.template.reconciliationDiscrepancies }, (_, i) => {
    const pack = i < 3;
    const customer = pack ? customers[i % 2] : customers[i % customers.length];
    return {
      id: id(`finding:${i}`),
      entity_type: "customer",
      entity_id: customer.id,
      kind: FINDING_KINDS[i % FINDING_KINDS.length],
      severity: SEVERITIES[i % SEVERITIES.length],
      source_values: JSON.stringify({
        crm: { name: customer.canonical_name, seenAt: at(-2) },
        erp: { name: customer.canonical_name.replace("LLC", "L.L.C."), seenAt: at(-3) },
      }),
      status: pack ? PACK_FINDING_STATUS[i] : TEMPLATE_FINDING_STATUS[i % 5],
      resolved_at: !pack && i % 5 >= 3 ? at(-1) : null,
      pack_key: pack ? `finding-${i + 1}` : null,
    };
  });

  const inventory_items = Array.from({ length: manifest.template.inventoryItems }, (_, i) => ({
    id: id(`item:${i}`),
    canonical_item_code: `SKU-${String(100 + i)}`,
    description: `Field supply ${String.fromCharCode(65 + i)} (fictional)`,
    canonical_unit: i % 2 ? "box" : "each",
    lifecycle_status: "Active",
    pack_key: i === 0 ? "item-1" : null,
  }));
  // F7: known, unknown SKU, mismatched unit, stale, and a second version of the same record.
  const inventory_snapshots = Array.from(
    { length: manifest.template.inventoryReferences },
    (_, i) => {
      const unknown = i % 7 === 3;
      const item = inventory_items[i % inventory_items.length];
      return {
        id: id(`snapshot:${i}`),
        item_id: unknown ? null : item.id,
        unresolved_source_ref: unknown ? `INV-UNKNOWN-${i}` : null,
        provider: "inventory_simulator",
        external_id: `INV-${200 + (i % 18)}`,
        quantity: String(10 + i * 3),
        unit: i % 7 === 5 ? "pallet" : (item.canonical_unit ?? "each"),
        source_version: i < 18 ? 1 : 2,
        observed_at: at(i % 7 === 2 ? -40 : -1),
        ingested_at: at(0),
        pack_key: i < 2 ? `snapshot-${i + 1}` : null,
      };
    },
  ).map((s, i) => (i === 1 ? { ...s, item_id: inventory_items[0].id, unit: "each" } : s));

  const workflow_rules = [
    ["Notify ops sheet when approved", "approval.completed", "sheet_append"],
    ["Show notice when a case needs review", "case.needs_review", "simulated_notice"],
  ].map(([name, trigger_event, action], i) => ({
    id: id(`rule:${i}`),
    name,
    trigger_event,
    condition: "{}",
    action,
    pack_key: `rule-${i + 1}`,
  }));

  // Seeded history. These labels are examples, never evidence that a message went anywhere.
  const outbox = [];
  for (const [label, count] of Object.entries(manifest.template.automationEvents.byLabel)) {
    for (let i = 0; i < count; i++) {
      const c = cases[outbox.length % cases.length];
      const type = outbox.length % 2 ? "case.created" : "approval.completed";
      const eventId = id(`outbox:${outbox.length}`);
      const ref = caseRefFor(c.id);
      outbox.push({
        id: eventId,
        event_type: type,
        payload_ref: ref,
        payload: JSON.stringify({
          id: eventId,
          type,
          version: 1,
          occurredAt: at(-outbox.length),
          workspaceMode: "demo",
          requestId: "seed",
          data:
            type === "case.created"
              ? { caseRef: ref, caseType: c.case_type }
              : { caseRef: ref, decision: "approved" },
        }),
        idempotency_key: `seed:${outbox.length}`,
        evidence_ref: label === "Confirmed" ? `seed-run-${outbox.length}` : null,
        created_at: at(-outbox.length),
        next_attempt_at: at(-outbox.length),
        ...AUTOMATION_LABELS[label],
      });
    }
  }

  const ACTIONS = ["case.status_changed", "case.handoff", "checklist.updated"];
  const activity = Array.from({ length: manifest.template.activityEvents }, (_, i) => ({
    actor_type: "system",
    actor_id: "seed",
    actor_role: "system",
    action: ACTIONS[i % ACTIONS.length],
    target: cases[i % cases.length].id,
    summary: "Seeded example activity (synthetic)",
    occurred_at: at(-i),
  }));

  return {
    customers,
    assignees,
    cases,
    checklist,
    approvals,
    documents,
    ai_reviews,
    links,
    relationships,
    findings,
    inventory_items,
    inventory_snapshots,
    workflow_rules,
    outbox,
    activity,
  };
}

// The P2-D query profile: many cases in one workspace, with activity on each.
export function buildProfile(manifest, customerId, assigneeId) {
  const clock = Date.parse(manifest.clock);
  const statuses = Object.keys(manifest.template.cases.byStatus);
  return Array.from({ length: manifest.profile.cases }, (_, n) => ({
    id: stableId(manifest.randomSeed, `profile-case:${n}`),
    customer_id: customerId,
    title: `${SUBJECTS[n % SUBJECTS.length]} profile ${String(n + 1).padStart(4, "0")}`,
    case_type: CASE_TYPES[n % CASE_TYPES.length],
    status: statuses[n % statuses.length],
    due_at: new Date(clock + ((n % 60) - 30) * DAY).toISOString(),
    created_at: new Date(clock - n * 3_600_000).toISOString(),
    assignee_id: n % 2 ? assigneeId : null,
  }));
}
