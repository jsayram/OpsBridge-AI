import { Hono } from "hono";
import { IDENTITY_LABEL } from "../auth/accessJwt";
import type { OwnerActor } from "../auth/actor";
import { withClient } from "../db";
import type { AppEnv } from "../env";

// Everything here sits behind ownerGate, mounted in app.ts ahead of this router.
export const admin = new Hono<AppEnv>();

admin.get("/status", (c) => {
  const actor = c.get("actor") as OwnerActor;
  return c.json({
    ownerIdentity: IDENTITY_LABEL,
    identityMode: actor.identityMode,
    simulated: actor.identityMode === "local-test-double",
  });
});

// Server-side revocation. Provider sign-out is the browser's next step, at the URL below.
admin.post("/logout", async (c) => {
  const actor = c.get("actor") as OwnerActor;
  await withClient(c.env.HYPERDRIVE, (db) =>
    db.query("SELECT app.revoke_owner_sessions($1, $2)", [actor.subject, c.get("requestId")]),
  );
  return c.json({ signedOut: true, providerLogoutPath: "/cdn-cgi/access/logout" });
});
