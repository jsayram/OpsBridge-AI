// Server-side capability table, one row per implemented line of
// docs/design/PERMISSIONS-MATRIX.md. Anything not listed is denied.
export type DemoRole = "viewer" | "analyst" | "manager";
export const DEMO_ROLES: readonly DemoRole[] = ["viewer", "analyst", "manager"];

export type Capability =
  | "cases:read"
  | "cases:edit"
  | "cases:handoff"
  | "cases:review"
  | "cases:reopen"
  | "approvals:decide"
  | "reconciliation:read"
  | "reconciliation:advance"
  | "reconciliation:resolve"
  | "integrations:read"
  | "integrations:sync_simulated"
  | "integrations:recover"
  | "integrations:live"
  | "inventory:read"
  | "automations:read"
  | "automations:manage"
  | "demo:reset"
  | "demo:switch_role"
  | "admin:access"
  | "documents:attach"
  | "documents:upload"
  | "ai:request"
  | "ai:live"
  | "ai:decide"
  | "analytics:read"
  | "analytics:snapshot"
  | "reports:export";

const GUEST_BASE: readonly Capability[] = [
  "cases:read",
  "reconciliation:read",
  "integrations:read",
  "inventory:read",
  "automations:read",
  "analytics:read",
  "reports:export",
  "demo:reset",
  "demo:switch_role",
];

const GUEST: Readonly<Record<DemoRole, readonly Capability[]>> = {
  viewer: GUEST_BASE,
  analyst: [
    ...GUEST_BASE,
    "cases:edit",
    "cases:handoff",
    "reconciliation:advance",
    "integrations:sync_simulated",
    "documents:attach",
    "ai:request",
  ],
  manager: [
    ...GUEST_BASE,
    "cases:edit",
    "cases:handoff",
    "cases:review",
    "cases:reopen",
    "approvals:decide",
    "reconciliation:advance",
    "reconciliation:resolve",
    "integrations:sync_simulated",
    "integrations:recover",
    "automations:manage",
    "documents:attach",
    "ai:request",
    "ai:decide",
    "analytics:snapshot",
  ],
};

const OWNER: readonly Capability[] = [
  "cases:read",
  "cases:edit",
  "cases:handoff",
  "cases:review",
  "cases:reopen",
  "approvals:decide",
  "reconciliation:read",
  "reconciliation:advance",
  "reconciliation:resolve",
  "integrations:read",
  "integrations:sync_simulated",
  "integrations:recover",
  "integrations:live",
  "inventory:read",
  "automations:read",
  "automations:manage",
  "admin:access",
  "documents:attach",
  "documents:upload",
  "ai:request",
  "ai:live",
  "ai:decide",
  "analytics:read",
  "analytics:snapshot",
  "reports:export",
];

export const guestCapabilities = (role: DemoRole) => GUEST[role];
export const ownerCapabilities = () => OWNER;
export const isDemoRole = (value: unknown): value is DemoRole =>
  typeof value === "string" && (DEMO_ROLES as readonly string[]).includes(value);
