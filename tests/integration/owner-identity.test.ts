import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { LOCAL_DOUBLE_AUDIENCE, LOCAL_DOUBLE_ISSUER } from "../../backend/src/auth/accessJwt";
import { call, connect, launch, mintOwnerToken, OWNER_SUBJECT, ownerEnv } from "./harness";

const STATUS = "/api/v1/admin/status";
const header = (token: string) => ({ "cf-access-jwt-assertion": token });
const asOwner = (token: string, path = STATUS, options = {}) =>
  call(path, { env: ownerEnv, headers: header(token), ...options });
const clearRevocation = async () => {
  const mig = await connect("opsbridge_migrator");
  await mig.query("UPDATE app.users SET sessions_valid_after = NULL, active = true");
  await mig.end();
};

describe("unconfigured identity is the safe default", () => {
  it("every admin path answers the same 404 as an unknown route", async () => {
    const unknown = await call("/api/v1/nothing-here");
    for (const path of [STATUS, "/api/v1/admin/integrations/x/sync", "/admin", "/admin/settings"]) {
      const res = await call(path);
      expect(res.status).toBe(404);
      expect(res.json.code).toBe(unknown.json.code);
      expect(res.json.message).toBe(unknown.json.message);
    }
  });

  it("a valid-looking token changes nothing while unconfigured", async () => {
    const res = await call(STATUS, { headers: header(await mintOwnerToken()) });
    expect(res.status).toBe(404);
  });

  it.each([
    ["no allowlist", { OWNER_SUBJECT_ALLOWLIST: "" }],
    ["unknown mode", { OWNER_IDENTITY_MODE: "off" }],
    [
      "access with a bad team domain",
      { OWNER_IDENTITY_MODE: "access", ACCESS_TEAM_DOMAIN: "evil.example.com", ACCESS_AUD: "x" },
    ],
    [
      "access with no audience",
      { OWNER_IDENTITY_MODE: "access", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" },
    ],
    ["double without keys", { OWNER_TEST_JWKS: undefined as never }],
  ])("%s stays closed", async (_name, patch) => {
    const res = await call(STATUS, {
      env: { ...ownerEnv, ...patch },
      headers: header(await mintOwnerToken()),
    });
    expect(res.status).toBe(404);
  });
});

describe("the test double can only exist locally", () => {
  it("refused when ENVIRONMENT is not local, or missing", async () => {
    const token = await mintOwnerToken();
    for (const ENVIRONMENT of ["staging", "production", undefined]) {
      const res = await call(STATUS, {
        env: { ...ownerEnv, ENVIRONMENT: ENVIRONMENT as never },
        headers: header(token),
      });
      expect(res.status).toBe(404);
    }
  });

  it("refused on a non-loopback host even in local mode", async () => {
    const res = await call(STATUS, {
      base: "https://staging.example.com",
      env: ownerEnv,
      headers: header(await mintOwnerToken()),
    });
    expect(res.status).toBe(404);
  });
});

describe("token verification", () => {
  it("accepts the allowlisted subject and labels the identity honestly", async () => {
    const res = await asOwner(await mintOwnerToken());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      ownerIdentity: "Pending Owner Configuration",
      identityMode: "local-test-double",
      simulated: true,
    });
  });

  it("also accepts the CF_Authorization cookie", async () => {
    const res = await call(STATUS, {
      env: ownerEnv,
      cookie: `CF_Authorization=${await mintOwnerToken()}`,
    });
    expect(res.status).toBe(200);
  });

  it("rejects a missing token with 401", async () => {
    const res = await call(STATUS, { env: ownerEnv });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe("owner_auth_required");
  });

  it.each([
    ["wrong issuer", () => mintOwnerToken({ iss: "https://other.cloudflareaccess.com" })],
    ["wrong audience", () => mintOwnerToken({ aud: "other-app" })],
    ["expired", () => mintOwnerToken({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ["no subject", () => mintOwnerToken({ sub: null })],
    ["garbage", async () => "not.a.jwt"],
  ])("%s gets 401", async (_name, make) => {
    const res = await asOwner(await make());
    expect(res.status).toBe(401);
  });

  it("rejects a token signed by another key", async () => {
    const other = await generateKeyPair("RS256");
    const res = await asOwner(await mintOwnerToken({ key: other.privateKey as never }));
    expect(res.status).toBe(401);
  });

  it("rejects a tampered payload", async () => {
    const token = await mintOwnerToken({ sub: "someone-else" });
    const [h, , s] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        sub: OWNER_SUBJECT,
        iss: LOCAL_DOUBLE_ISSUER,
        aud: LOCAL_DOUBLE_AUDIENCE,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString("base64url");
    expect((await asOwner(`${h}.${forged}.${s}`)).status).toBe(401);
  });

  it("rejects algorithm none and HS256 confusion", async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: OWNER_SUBJECT,
      iss: LOCAL_DOUBLE_ISSUER,
      aud: LOCAL_DOUBLE_AUDIENCE,
      iat: now,
      exp: now + 300,
    };
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const none = `${b64({ alg: "none" })}.${b64(claims)}.`;
    expect((await asOwner(none)).status).toBe(401);
    const hs = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", kid: "double-1" })
      .sign(new TextEncoder().encode(ownerEnv.OWNER_TEST_JWKS as string));
    expect((await asOwner(hs)).status).toBe(401);
  });

  it("unknown subject gets 403 even with a perfect signature", async () => {
    const res = await asOwner(await mintOwnerToken({ sub: "not-on-the-list" }));
    expect(res.status).toBe(403);
  });

  it("the subject match is exact, not a prefix or case fold", async () => {
    expect((await asOwner(await mintOwnerToken({ sub: `${OWNER_SUBJECT}x` }))).status).toBe(403);
    expect((await asOwner(await mintOwnerToken({ sub: OWNER_SUBJECT.toUpperCase() }))).status).toBe(
      403,
    );
  });
});

describe("logout and revocation", () => {
  it("logout kills every token issued up to that moment, and a later login works", async () => {
    await clearRevocation();
    const iat = Math.floor(Date.now() / 1000) - 5;
    const token = await mintOwnerToken({ iat });
    expect((await asOwner(token)).status).toBe(200);
    const out = await asOwner(token, "/api/v1/admin/logout", { method: "POST" });
    expect(out.status).toBe(200);
    expect(out.json.providerLogoutPath).toBe("/cdn-cgi/access/logout");
    expect((await asOwner(token)).status).toBe(401);
    expect((await asOwner(token, "/api/v1/me")).status).toBe(401);
    const later = await mintOwnerToken({ iat: Math.floor(Date.now() / 1000) + 2 });
    expect((await asOwner(later)).status).toBe(200);
    await clearRevocation();
  });

  it("logout is audited and needs our origin", async () => {
    await clearRevocation();
    const token = await mintOwnerToken({ iat: Math.floor(Date.now() / 1000) - 5 });
    const evil = await asOwner(token, "/api/v1/admin/logout", {
      method: "POST",
      origin: "https://evil.example.com",
    });
    expect(evil.status).toBe(403);
    await asOwner(token, "/api/v1/admin/logout", { method: "POST" });
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT count(*)::int AS n FROM app.audit_events WHERE action = 'owner.logout'",
    );
    await mig.end();
    expect(rows[0].n).toBeGreaterThan(0);
    await clearRevocation();
  });

  it("a deactivated user is refused immediately", async () => {
    await clearRevocation();
    const token = await mintOwnerToken();
    expect((await asOwner(token)).status).toBe(200);
    const mig = await connect("opsbridge_migrator");
    await mig.query("UPDATE app.users SET active = false WHERE oidc_subject = $1", [OWNER_SUBJECT]);
    await mig.end();
    expect((await asOwner(token)).status).toBe(403);
    await clearRevocation();
  });
});

describe("P1-C guest to admin", () => {
  it("guest cookie, edited role and guessed paths all get 401 with no data", async () => {
    const g = await launch();
    for (const path of [
      STATUS,
      "/api/v1/admin/integrations/1/sync",
      "/api/v1/admin/automations/runs/1/retry",
      "/admin",
    ]) {
      const res = await call(path, { env: ownerEnv, cookie: g.cookie });
      expect(res.status).toBe(401);
      expect(res.text).not.toMatch(/subject|issuer|cloudflareaccess|allowlist/i);
    }
    const post = await call("/api/v1/admin/integrations/1/sync", {
      method: "POST",
      env: ownerEnv,
      cookie: g.cookie,
      body: { role: "owner" },
    });
    expect(post.status).toBe(401);
  });

  it("a forged token in a guest cookie jar is refused, not ignored into guest", async () => {
    const g = await launch();
    const res = await call("/api/v1/me", {
      env: ownerEnv,
      cookie: `${g.cookie}; CF_Authorization=forged.token.here`,
    });
    expect(res.status).toBe(401);
  });

  it("the admin page is served only to a verified owner, with a page CSP", async () => {
    const res = await asOwner(await mintOwnerToken(), "/admin");
    expect(res.status).toBe(200);
    expect(res.text).toContain("spa");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
