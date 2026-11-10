// P4.1: typed rules. A rule is a trigger from the closed event list, a condition made only of
// allowlisted fields with enumerated values, and an action from a closed list. There is no field
// that can hold a URL, an address, a recipient or code, so none can be smuggled in: anything not
// named here is rejected before it reaches the database. One evaluator serves every team, which is
// what JOB-TEST-06 reuses.
import { CASE_TYPES, QUEUES } from "./caseVocabulary";
import type { EventType } from "./events";

export const EVENT_TYPES: readonly EventType[] = [
  "case.created",
  "case.needs_review",
  "approval.completed",
  "reconciliation.resolved",
  "integration.degraded",
];
export const RULE_ACTIONS = ["sheet_append", "simulated_notice"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

const FINDING_KINDS = [
  "definition_conflict",
  "name_mismatch",
  "account_mismatch",
  "duplicate_client",
  "missing_client",
  "source_deleted",
  "unknown_sku",
  "unit_mismatch",
  "invalid_unit",
  "stale_snapshot",
] as const;
const PROVIDERS = ["crm_simulator", "erp_simulator", "inventory_simulator", "salesforce_test"];

// Per trigger, the only fields a condition may test and the only values each may hold.
export const CONDITION_FIELDS: Readonly<
  Record<EventType, Readonly<Record<string, readonly string[]>>>
> = {
  "case.created": { queue: QUEUES, caseType: CASE_TYPES },
  "case.needs_review": { queue: QUEUES, reason: ["intake", "returned", "reopened"] },
  "approval.completed": { queue: QUEUES, decision: ["approved", "rejected"] },
  "reconciliation.resolved": { kind: FINDING_KINDS },
  "integration.degraded": { provider: PROVIDERS },
};

export type Condition = Readonly<Record<string, string>>;

export type Rule = {
  id: string;
  name: string;
  trigger: EventType;
  condition: Condition;
  action: RuleAction;
  enabled: boolean;
  version: number;
};

export class RuleError extends Error {
  constructor(readonly field: string) {
    super(`invalid ${field}`);
    this.name = "RuleError";
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isEventType = (v: unknown): v is EventType =>
  typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v);

export const isRuleAction = (v: unknown): v is RuleAction =>
  typeof v === "string" && (RULE_ACTIONS as readonly string[]).includes(v);

// Rejects anything outside the allowlist. Returns a fresh object, so the caller never stores the
// input it was handed.
export function parseCondition(trigger: EventType, input: unknown): Condition {
  if (!isPlainObject(input)) throw new RuleError("condition");
  const allowed = CONDITION_FIELDS[trigger];
  const out: Record<string, string> = {};
  const keys = Object.keys(input);
  if (keys.length > Object.keys(allowed).length) throw new RuleError("condition");
  for (const key of keys) {
    const values = Object.hasOwn(allowed, key) ? allowed[key] : undefined;
    const value = input[key];
    if (!values || typeof value !== "string" || !values.includes(value)) {
      throw new RuleError(`condition.${key}`);
    }
    out[key] = value;
  }
  return out;
}

// A rule name is a label people read. It still can't carry an address or a link, so nobody can
// dress up a recipient as a name and hope a later feature trusts it.
const NAME_FORBIDDEN = /:\/\/|@|<|>|\bwww\.|\bjavascript:|\{\{|\$\{/i;

export function parseRuleName(input: unknown): string {
  if (typeof input !== "string") throw new RuleError("name");
  const name = input.trim();
  if (name.length < 1 || name.length > 120 || NAME_FORBIDDEN.test(name)) {
    throw new RuleError("name");
  }
  return name;
}

// The one evaluator. Every field in the condition must equal the event's value. An empty condition
// matches every event of the trigger's type.
export function matches(rule: Rule, type: EventType, data: Record<string, unknown>): boolean {
  if (!rule.enabled || rule.trigger !== type) return false;
  return Object.entries(rule.condition).every(([key, value]) => data[key] === value);
}

export const matchingRules = (
  rules: readonly Rule[],
  type: EventType,
  data: Record<string, unknown>,
) => rules.filter((r) => matches(r, type, data));

// Checks sample event data for the simulator, against the same allowlist as conditions.
export function parseSampleData(type: EventType, input: unknown): Record<string, string> {
  if (!isPlainObject(input)) throw new RuleError("data");
  return parseCondition(type, input);
}

const FIELD_LABEL: Record<string, string> = {
  queue: "team",
  caseType: "case type",
  reason: "reason",
  decision: "decision",
  kind: "finding kind",
  provider: "source",
};

export function describeCondition(condition: Condition): string {
  const parts = Object.entries(condition).map(([k, v]) => `${FIELD_LABEL[k] ?? k} is ${v}`);
  return parts.length ? parts.join(" and ") : "every event of this type";
}
