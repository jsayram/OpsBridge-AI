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
  DEMO_LAUNCH_HOURLY_LIMIT?: string;
  DEMO_RESET_LIMIT?: string;
  DEMO_WORKSPACE_CAP?: string;
  DEMO_TTL_SECONDS?: string;
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

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : fallback;
};

// Defaults are the PRD and threat-model numbers. Overrides exist for local tests.
export const demoLimits = (env: Bindings) => ({
  ttlSeconds: positiveInt(env.DEMO_TTL_SECONDS, 7200),
  hourlyLaunchLimit: positiveInt(env.DEMO_LAUNCH_HOURLY_LIMIT, 5),
  resetLimit: positiveInt(env.DEMO_RESET_LIMIT, 5),
  workspaceCap: positiveInt(env.DEMO_WORKSPACE_CAP, 150),
});
