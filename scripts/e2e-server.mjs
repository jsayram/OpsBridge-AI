#!/usr/bin/env node
// Starts the real Worker under wrangler dev against a fresh local database, with the
// owner test double enabled. Used by Playwright only.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { exportJWK, generateKeyPair } from "jose";
import { localUrl, migrate, relaxLimits, seed, setupLocal } from "./db.mjs";

const DB = "opsbridge_e2e";
const PORT = "8788";
const OWNER_SUBJECT = "e2e-double-owner-subject";

await setupLocal(DB, { recreate: true });
await migrate(localUrl("opsbridge_migrator", DB));
await seed(localUrl("opsbridge_migrator", DB));
await relaxLimits(localUrl("opsbridge_migrator", DB));

const pair = await generateKeyPair("RS256", { extractable: true });
const pub = { ...(await exportJWK(pair.publicKey)), kid: "double-1", alg: "RS256" };
mkdirSync(".wrangler/e2e", { recursive: true });
writeFileSync(
  ".wrangler/e2e/identity.json",
  JSON.stringify({ privateJwk: await exportJWK(pair.privateKey), subject: OWNER_SUBJECT }),
);
writeFileSync(
  ".wrangler/e2e/dev.vars",
  [
    "IP_HASH_KEY=e2e-only-not-a-secret",
    "OWNER_IDENTITY_MODE=local-test-double",
    `OWNER_SUBJECT_ALLOWLIST=${OWNER_SUBJECT}`,
    `OWNER_TEST_JWKS='${JSON.stringify({ keys: [pub] })}'`,
    "",
  ].join("\n"),
);

const built = spawnSync("npx", ["vite", "build", "--config", "frontend/vite.config.ts"], {
  stdio: "inherit",
});
if (built.status !== 0) process.exit(built.status ?? 1);

const conn = (role) => `postgres://${role}:local_dev_only@127.0.0.1:54330/${DB}?sslmode=disable`;
const child = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--port",
    PORT,
    "--inspector-port",
    "9240",
    "--env-file",
    ".wrangler/e2e/dev.vars",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: conn("opsbridge_app"),
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CLEANUP: conn("opsbridge_cleanup"),
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_DISPATCH:
        conn("opsbridge_dispatcher"),
    },
  },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
