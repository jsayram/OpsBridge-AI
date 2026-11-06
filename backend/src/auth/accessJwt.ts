import { createLocalJWKSet, createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { Bindings } from "../env";

// Owner identity boundary. Provider status: Pending Owner Configuration (DEC-002).
// Cloudflare Access is proposed, so this verifies Access-shaped tokens. Nothing here has
// met a real Access team yet; the JWKS fetch path is only exercised with a stub.

export const IDENTITY_LABEL = "Pending Owner Configuration";
export const LOCAL_DOUBLE_ISSUER = "https://local-test-double.invalid";
export const LOCAL_DOUBLE_AUDIENCE = "opsbridge-local-test-double";
const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type IdentityMode = "access" | "local-test-double";

export type IdentityConfig = {
  mode: IdentityMode;
  issuer: string;
  audience: string;
  subjects: ReadonlySet<string>;
  keys: Parameters<typeof jwtVerify>[1];
};

const allowlist = (raw: string | undefined) =>
  new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

// Null means unconfigured, and every admin path then answers 404. Any incomplete or
// inconsistent setting lands here, so a mistake can't open the boundary.
export function identityConfig(env: Bindings, requestUrl: string): IdentityConfig | null {
  const subjects = allowlist(env.OWNER_SUBJECT_ALLOWLIST);
  if (subjects.size === 0) return null;

  if (env.OWNER_IDENTITY_MODE === "access") {
    const team = env.ACCESS_TEAM_DOMAIN ?? "";
    if (!TEAM_DOMAIN.test(team) || !env.ACCESS_AUD) return null;
    const issuer = `https://${team}`;
    return {
      mode: "access",
      issuer,
      audience: env.ACCESS_AUD,
      subjects,
      keys: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
    };
  }

  // The double only supplies a public key to the same verifier; it is not a bypass. It
  // works on a loopback request in the local environment and nowhere else.
  if (env.OWNER_IDENTITY_MODE === "local-test-double") {
    if (env.ENVIRONMENT !== "local") return null;
    if (!LOOPBACK.has(new URL(requestUrl).hostname)) return null;
    if (!env.OWNER_TEST_JWKS) return null;
    return {
      mode: "local-test-double",
      issuer: LOCAL_DOUBLE_ISSUER,
      audience: LOCAL_DOUBLE_AUDIENCE,
      subjects,
      keys: createLocalJWKSet(JSON.parse(env.OWNER_TEST_JWKS)),
    };
  }
  return null;
}

export type VerifiedOwner = { subject: string; issuedAt: number };
export type VerifyResult =
  | { ok: true; owner: VerifiedOwner }
  | { ok: false; reason: "invalid_token" | "unknown_subject" };

export async function verifyOwnerToken(
  token: string,
  config: IdentityConfig,
): Promise<VerifyResult> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, config.keys as never, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 5,
    }));
  } catch {
    return { ok: false, reason: "invalid_token" };
  }
  const subject = payload.sub ?? "";
  // Exact subject only. Email is display data and never decides anything.
  if (!config.subjects.has(subject)) return { ok: false, reason: "unknown_subject" };
  return { ok: true, owner: { subject, issuedAt: payload.iat as number } };
}
