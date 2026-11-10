import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { identityConfig } from "../../backend/src/auth/accessJwt";
import type { Bindings } from "../../backend/src/env";

const base = { OWNER_SUBJECT_ALLOWLIST: "a, b" } as Bindings;

describe("identityConfig", () => {
  it("is null by default", () => {
    expect(identityConfig({} as Bindings, "http://localhost/")).toBeNull();
  });

  it("derives issuer and JWKS only from a real Access team domain, and fetches nothing yet", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const config = identityConfig(
      {
        ...base,
        OWNER_IDENTITY_MODE: "access",
        ACCESS_TEAM_DOMAIN: "northstar.cloudflareaccess.com",
        ACCESS_AUD: "aud-tag",
      },
      "https://stage.example.com/",
    );
    expect(config?.issuer).toBe("https://northstar.cloudflareaccess.com");
    expect(config?.audience).toBe("aud-tag");
    expect([...(config?.subjects ?? [])]).toEqual(["a", "b"]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each([
    "evil.example.com",
    "x.cloudflareaccess.com.evil.example.com",
    "a/b.cloudflareaccess.com",
    "",
  ])("refuses team domain %s", (team) => {
    const env = {
      ...base,
      OWNER_IDENTITY_MODE: "access",
      ACCESS_TEAM_DOMAIN: team,
      ACCESS_AUD: "aud",
    };
    expect(identityConfig(env, "https://stage.example.com/")).toBeNull();
  });
});

describe("headers stay in one place", () => {
  it("asset CSP in _headers matches the Worker page CSP", async () => {
    const { PAGE_CSP } = await import("../../backend/src/app");
    const headers = readFileSync("frontend/public/_headers", "utf8");
    expect(headers).toContain(
      `default-src ${PAGE_CSP.defaultSrc[0]}; object-src ${PAGE_CSP.objectSrc[0]}; frame-ancestors ${PAGE_CSP.frameAncestors[0]}; base-uri ${PAGE_CSP.baseUri[0]}; form-action ${PAGE_CSP.formAction[0]}`,
    );
  });
});
