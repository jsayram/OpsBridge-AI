import type { Actor } from "./auth/actor";
import type { Transport } from "./integrations/types";

export type Bindings = {
  ASSETS: Fetcher;
  HYPERDRIVE: Hyperdrive;
  HYPERDRIVE_CLEANUP: Hyperdrive;
  API_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  // "local", "staging" or "production". Anything missing is treated as production.
  ENVIRONMENT?: string;
  APP_ORIGIN?: string;
  IP_HASH_KEY?: string;
  DEMO_LAUNCH_PAUSED?: string;
  OWNER_IDENTITY_MODE?: string;
  OWNER_SUBJECT_ALLOWLIST?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_TEST_JWKS?: string;
  SYNC_PAGES_PER_CALL?: string;
  // Owner-only Salesforce connector. Off unless every value is present (docs/ENVIRONMENTS.md).
  SALESFORCE_ENABLED?: string;
  SALESFORCE_LOGIN_URL?: string;
  SALESFORCE_CLIENT_ID?: string;
  SALESFORCE_CLIENT_SECRET?: string;
  SALESFORCE_REDIRECT_URI?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  // In-process test double. Worker variables are strings, so a deployed Worker can't set one.
  SALESFORCE_TEST_DOUBLE?: Transport;
};

export type Variables = {
  requestId: string;
  actor: Actor;
  errorCode?: string;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
