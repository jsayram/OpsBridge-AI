import { describe, expect, it } from "vitest";
import {
  DEMO_ROLES,
  guestCapabilities,
  isDemoRole,
  ownerCapabilities,
} from "../../backend/src/auth/policy";

describe("capabilities match the permissions matrix", () => {
  it("no guest role ever holds an admin capability", () => {
    for (const role of DEMO_ROLES) expect(guestCapabilities(role)).not.toContain("admin:access");
  });
  it("viewer reads, analyst and manager edit", () => {
    expect(guestCapabilities("viewer")).not.toContain("cases:edit");
    expect(guestCapabilities("analyst")).toContain("cases:edit");
    expect(guestCapabilities("manager")).toContain("cases:edit");
  });
  it("owner has admin but no demo controls", () => {
    expect(ownerCapabilities()).toContain("admin:access");
    expect(ownerCapabilities()).not.toContain("demo:reset");
    expect(ownerCapabilities()).not.toContain("demo:switch_role");
  });
  it("role parsing is exact", () => {
    for (const bad of ["owner", "admin", "Viewer", "", null, 0, {}]) {
      expect(isDemoRole(bad)).toBe(false);
    }
  });
});
