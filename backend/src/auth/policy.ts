// Server-side capability table, one row per implemented line of
// docs/design/PERMISSIONS-MATRIX.md. Anything not listed is denied.
export type DemoRole = "viewer" | "analyst" | "manager";
export const DEMO_ROLES: readonly DemoRole[] = ["viewer", "analyst", "manager"];

export type Capability =
  | "cases:read"
  | "cases:edit"
  | "demo:reset"
  | "demo:switch_role"
  | "admin:access";

const GUEST_BASE: readonly Capability[] = ["cases:read", "demo:reset", "demo:switch_role"];

const GUEST: Readonly<Record<DemoRole, readonly Capability[]>> = {
  viewer: GUEST_BASE,
  analyst: [...GUEST_BASE, "cases:edit"],
  manager: [...GUEST_BASE, "cases:edit"],
};

const OWNER: readonly Capability[] = ["cases:read", "cases:edit", "admin:access"];

export const guestCapabilities = (role: DemoRole) => GUEST[role];
export const ownerCapabilities = () => OWNER;
export const isDemoRole = (value: unknown): value is DemoRole =>
  typeof value === "string" && (DEMO_ROLES as readonly string[]).includes(value);
