// Deterministic template dataset: same manifest, same records. P1 covers organizations and
// cases, the two Section 16 groups that have tables yet; the rest arrive with their tables.
import { createHash } from "node:crypto";

export const TEMPLATE_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export const OWNER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
export const OWNER_CUSTOMER_ID = "00000000-0000-4000-8000-000000000003";
export const OWNER_CASE_ID = "00000000-0000-4000-8000-000000000004";

const stableId = (seed, key) => {
  const h = createHash("sha256").update(`${seed}:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const CASE_TYPES = ["Onboarding", "Billing", "Renewal", "Field issue"];
const SUBJECTS = [
  "Seasonal crew onboarding",
  "Billing entity review",
  "Contract renewal check",
  "Site access checklist",
  "Timesheet mismatch",
  "Equipment handoff",
];

export function buildTemplate(manifest) {
  const seed = manifest.randomSeed;
  const clock = Date.parse(manifest.clock);
  const customers = manifest.organizationNames.map((name, i) => ({
    id: stableId(seed, `customer:${i}`),
    canonical_name: name,
    account_code: `NS-${String(1001 + i)}`,
    lifecycle_status: i === 5 ? "Prospect" : "Active",
    pack_key: i < 2 ? `customer-${i + 1}` : null,
  }));
  const packStatuses = ["Intake", "Needs Review", "Ready"];
  const cases = [];
  let n = 0;
  for (const [status, count] of Object.entries(manifest.template.cases.byStatus)) {
    for (let i = 0; i < count; i++, n++) {
      const packIndex = i === 0 ? packStatuses.indexOf(status) : -1;
      const customer = packIndex >= 0 ? customers[packIndex % 2] : customers[n % customers.length];
      cases.push({
        id: stableId(seed, `case:${n}`),
        customer_id: customer.id,
        title: `${SUBJECTS[n % SUBJECTS.length]} ${String(n + 1).padStart(3, "0")}`,
        case_type: CASE_TYPES[n % CASE_TYPES.length],
        status,
        due_at: new Date(clock + ((n % 21) - 7) * 86_400_000).toISOString(),
        pack_key: packIndex >= 0 ? `case-${packIndex + 1}` : null,
      });
    }
  }
  return { customers, cases };
}
