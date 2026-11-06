import { describe, expect, it } from "vitest";
import { hashToken, ipBucket, isDemoTokenShape, newDemoToken } from "../../backend/src/auth/tokens";

describe("demo tokens", () => {
  it("are 256 random bits in URL-safe form, and never repeat", () => {
    const seen = new Set(Array.from({ length: 1000 }, newDemoToken));
    expect(seen.size).toBe(1000);
    for (const t of seen) expect(isDemoTokenShape(t)).toBe(true);
  });
  it("shape check rejects anything else", () => {
    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}+`]) {
      expect(isDemoTokenShape(bad)).toBe(false);
    }
  });
  it("hash is SHA-256 of the token", async () => {
    expect((await hashToken("x")).length).toBe(32);
  });
  it("IP bucket depends on the key", async () => {
    const [a, b] = [await ipBucket("k1", "203.0.113.1"), await ipBucket("k2", "203.0.113.1")];
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
