# Owner identity runbook

**State: Pending Owner Configuration.** Cloudflare Access is proposed, not accepted (DEC-002). The verifier is built and tested with a local test double. No real sign-in, MFA or provider token has ever passed through it.

## How it works

Access signs a JWT after the owner signs in at the provider. The Worker reads it from the `Cf-Access-Jwt-Assertion` header, or the `CF_Authorization` cookie on paths Access doesn't sit in front of. The verifier checks RS256 signature, issuer, audience, expiry, then the exact subject against `OWNER_SUBJECT_ALLOWLIST`. Email decides nothing.

| Situation | Response |
|---|---|
| Identity not configured, or configured wrongly | 404 on every admin path, same as an unknown route |
| Configured, no token, bad token, revoked token | 401 |
| Valid token, subject not on the list, or user inactive | 403 |

## Local test double

It is a throwaway RSA key pair made per test run, so its only job is to supply a public key to the same verifier. There is no bypass path. `identityConfig` ignores it unless `ENVIRONMENT` is `local` and the request host is loopback, and `scripts/check-release-config.mjs` refuses it in a release config. The admin page labels it **Local test double**.

## Setup after DEC-002

1. Jose creates the Access application for the staging origin, covering `/admin` and `/api/v1/admin/*`, with an MFA-required policy for his identity only.
2. Copy the team domain and audience tag into the staging config.
3. Sign in once and read `sub` from a real token. **The Cloudflare page on JWT validation doesn't document `sub`, so confirm the claim exists and is stable before relying on it.** If it isn't there, stop and revisit this design.
4. Set `OWNER_SUBJECT_ALLOWLIST` with `wrangler secret put`.
5. Check the `iat` claim exists, since revocation depends on it.
6. Test: sign in, unknown identity, logout, MFA prompt. Record real evidence, then change this file's state.

Not verifiable until then: whether `CF_Authorization` arrives on paths outside the Access application, and key rotation against the real JWKS. Access rotates keys about every 6 weeks. The verifier caches keys per isolate for 10 minutes and refetches on an unknown key ID at most once a minute, which a stub-provider test covers.

## Logout and revocation

`POST /api/v1/admin/logout` sets `users.sessions_valid_after` and writes `owner.logout` to the audit trail. A token issued at or before that second is refused from then on, even inside its own expiry. The admin page then sends the browser to `/cdn-cgi/access/logout`, which ends the Access session. With the test double it stays put and says no provider session exists.

Provider-side nonce and state belong to the Access sign-in flow. The Worker receives a finished token and has no callback of its own, so callback tampering is a provider-side check at setup.

## Incidents

- **Suspected owner compromise:** revoke at the provider, call logout, or as the migrator set `active = false` on the user. Access is refused on the next request.
- **Lockout:** `active` and `sessions_valid_after` are data, so the migrator can restore them. Removing the allowlist makes all admin paths 404 without touching data.
- **Guest session compromise:** sessions last 2 hours and hold only synthetic data. Pause launches with `DEMO_LAUNCH_PAUSED=true`. Rotating `IP_HASH_KEY` resets quota buckets and has no effect on sessions.
