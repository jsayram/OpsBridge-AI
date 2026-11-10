import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { withClient } from "../db";
import type { AppEnv } from "../env";
import { ApiError, forbidden, notFound } from "../http/errors";
import {
  type IdentityConfig,
  identityConfig,
  type VerifiedOwner,
  verifyOwnerToken,
} from "./accessJwt";
import { type Capability, type DemoRole, guestCapabilities, ownerCapabilities } from "./policy";
import { DEMO_COOKIE, hashToken, isDemoTokenShape } from "./tokens";

export type GuestActor = {
  kind: "guest";
  sessionId: string;
  workspaceId: string;
  demoRole: DemoRole;
  expiresAt: Date;
  tokenHash: Uint8Array;
};
export type OwnerActor = {
  kind: "owner";
  userId: string;
  subject: string;
  workspaceId: string;
  identityMode: IdentityConfig["mode"];
};
export type Actor = GuestActor | OwnerActor;

export const capabilitiesOf = (actor: Actor): readonly Capability[] =>
  actor.kind === "owner" ? ownerCapabilities() : guestCapabilities(actor.demoRole);

const ACCESS_HEADER = "cf-access-jwt-assertion";
const ACCESS_COOKIE = "CF_Authorization";

const ownerToken = (c: Context<AppEnv>) =>
  c.req.header(ACCESS_HEADER) ?? getCookie(c, ACCESS_COOKIE);

const ownerAuthRequired = () => new ApiError(401, "owner_auth_required", "Sign-in required");

async function ownerFrom(c: Context<AppEnv>, config: IdentityConfig, verified: VerifiedOwner) {
  const { rows } = await withClient(c.env.HYPERDRIVE, (db) =>
    db.query("SELECT * FROM app.resolve_owner($1)", [verified.subject]),
  );
  const row = rows[0];
  if (!row?.active) throw forbidden();
  const validAfter = row.sessions_valid_after as Date | null;
  // Logout and revocation: a token minted at or before that moment is dead here, even
  // while it is still inside its provider-side expiry.
  if (validAfter && verified.issuedAt <= Math.floor(validAfter.getTime() / 1000)) {
    throw ownerAuthRequired();
  }
  const actor: OwnerActor = {
    kind: "owner",
    userId: row.user_id,
    subject: verified.subject,
    workspaceId: row.ws_id,
    identityMode: config.mode,
  };
  return actor;
}

async function resolveGuest(c: Context<AppEnv>): Promise<GuestActor | null> {
  const token = getCookie(c, DEMO_COOKIE);
  if (!token) return null;
  const expired = () => {
    deleteCookie(c, DEMO_COOKIE, { path: "/", secure: true });
    return new ApiError(401, "session_expired", "Your demo session has ended");
  };
  if (!isDemoTokenShape(token)) throw expired();
  const tokenHash = await hashToken(token);
  const { rows } = await withClient(c.env.HYPERDRIVE, (db) =>
    db.query("SELECT * FROM app.resolve_demo_session($1)", [tokenHash]),
  );
  const row = rows[0];
  if (!row) throw expired();
  return {
    kind: "guest",
    sessionId: row.session_id,
    workspaceId: row.ws_id,
    demoRole: row.role,
    expiresAt: row.session_expires_at,
    tokenHash,
  };
}

// Deny by default. Every /api/v1 route sits behind this except the demo launch.
export const requireActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const config = identityConfig(c.env, c.req.url);
  const token = config ? ownerToken(c) : undefined;
  if (config && token) {
    const result = await verifyOwnerToken(token, config);
    if (!result.ok) throw ownerAuthRequired();
    c.set("actor", await ownerFrom(c, config, result.owner));
    return next();
  }
  const guest = await resolveGuest(c);
  if (!guest) throw new ApiError(401, "no_session", "Start a demo session first");
  c.set("actor", guest);
  return next();
};

export const requireCapability =
  (capability: Capability): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (!capabilitiesOf(c.get("actor")).includes(capability)) throw forbidden();
    return next();
  };

// In front of every admin path, before routing, so a guest learns nothing about which
// admin routes exist. Unconfigured identity makes them all look absent.
export const ownerGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const config = identityConfig(c.env, c.req.url);
  if (!config) throw notFound();
  const token = ownerToken(c);
  if (!token) throw ownerAuthRequired();
  const result = await verifyOwnerToken(token, config);
  if (!result.ok) {
    if (result.reason === "unknown_subject") throw forbidden();
    throw ownerAuthRequired();
  }
  c.set("actor", await ownerFrom(c, config, result.owner));
  return next();
};
