import type { Actor } from "./auth/actor";

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
};

export type Variables = {
  requestId: string;
  actor: Actor;
  errorCode?: string;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
