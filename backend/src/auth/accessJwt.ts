import {
  createLocalJWKSet,
  errors,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import type { Bindings } from "../env";

// Owner identity boundary. Provider status: Pending Owner Configuration (DEC-002).
// Cloudflare Access is proposed, so this verifies Access-shaped tokens. Nothing here has
// met a real Access team yet; the JWKS fetch path only runs against a stub in tests.

export const IDENTITY_LABEL = "Pending Owner Configuration";
export const LOCAL_DOUBLE_ISSUER = "https://local-test-double.invalid";
export const LOCAL_DOUBLE_AUDIENCE = "opsbridge-local-test-double";
const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const KEYS_FRESH_MS = 10 * 60_000;
const KEYS_MIN_REFETCH_MS = 60_000;
const KEYS_TIMEOUT_MS = 5000;

type KeyCache = { jwks: JSONWebKeySet; fetchedAt: number };
const keyCaches = new Map<string, KeyCache>();

export const clearKeyCache = () => keyCaches.clear();

// Keys are plain JSON, cached per isolate. No promise or socket is shared across requests,
// which workerd forbids. An unknown key ID refetches at most once a minute, so anonymous
// tokens can't turn into a stream of outbound requests. Access rotates keys about every
// 6 weeks and keeps the old one valid for 7 days.
async function loadKeys(url: string): Promise<KeyCache> {
  const res = await fetch(url, { signal: AbortSignal.timeout(KEYS_TIMEOUT_MS) });
  if (!res.ok) throw new Error("jwks_unavailable");
  const cache = { jwks: (await res.json()) as JSONWebKeySet, fetchedAt: Date.now() };
  keyCaches.set(url, cache);
  return cache;
}

type KeyResolver = JWTVerifyGetKey;

const cachedKeys =
  (url: string): KeyResolver =>
  async (header, token) => {
    let cache = keyCaches.get(url);
    if (!cache || Date.now() - cache.fetchedAt > KEYS_FRESH_MS) cache = await loadKeys(url);
    try {
      return await createLocalJWKSet(cache.jwks)(header, token);
    } catch (e) {
      if (!(e instanceof errors.JWKSNoMatchingKey)) throw e;
      if (Date.now() - cache.fetchedAt < KEYS_MIN_REFETCH_MS) throw e;
      return await createLocalJWKSet((await loadKeys(url)).jwks)(header, token);
    }
  };

export type IdentityMode = "access" | "local-test-double";

export type IdentityConfig = {
  mode: IdentityMode;
  issuer: string;
  audience: string;
  subjects: ReadonlySet<string>;
  keys: KeyResolver;
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
      keys: cachedKeys(`${issuer}/cdn-cgi/access/certs`),
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
    ({ payload } = await jwtVerify(token, config.keys, {
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
