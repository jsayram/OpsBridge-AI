#!/usr/bin/env node
// Blocks a release from a config that could weaken the boundary. Reads a rendered Wrangler
// config and exits non-zero on the first run of problems.
//   node scripts/check-release-config.mjs <rendered-config.jsonc>
import { readFileSync } from "node:fs";

const [file] = process.argv.slice(2);
if (!file) {
  console.error("usage: check-release-config.mjs <config>");
  process.exit(2);
}
const raw = readFileSync(file, "utf8");
const config = JSON.parse(
  raw
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
    .replace(/,(\s*[}\]])/g, "$1"),
);
const text = JSON.stringify(config);
const vars = config.vars ?? {};
const errors = [];
const need = (ok, message) => {
  if (!ok) errors.push(message);
};
need(!/local-test-double/.test(text), "test identity double in a release config");
need(!/OWNER_TEST_JWKS/.test(text), "test double keys in a release config");
need(!/localConnectionString/.test(text), "local database connection");
need(!/local_dev_only/.test(text), "local password");
need(!/REPLACE_/.test(text), "unfilled placeholder");
need(
  ["staging", "production"].includes(vars.ENVIRONMENT),
  "ENVIRONMENT must be staging or production",
);
need(/^https:\/\/[^/]+$/.test(vars.APP_ORIGIN ?? ""), "APP_ORIGIN must be an https origin");
need(/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date ?? ""), "pinned compatibility date");
const worker = config.assets?.run_worker_first ?? [];
for (const path of ["/api/*", "/health/*", "/admin", "/admin/*"]) {
  need(worker.includes(path), `run_worker_first must include ${path}`);
}
need(config.triggers?.crons?.includes("*/30 * * * *"), "the purge cron is missing");
const hd = config.hyperdrive ?? [];
const id = (name) => hd.find((h) => h.binding === name)?.id;
need(id("HYPERDRIVE") && id("HYPERDRIVE_CLEANUP"), "both Hyperdrive bindings are required");
need(
  id("HYPERDRIVE") !== id("HYPERDRIVE_CLEANUP"),
  "app and cleanup need separate Hyperdrive configs",
);
need(!hd.some((h) => /^0+[12]$/.test(h.id ?? "")), "placeholder Hyperdrive ID");
need(
  config.ratelimits?.some((r) => r.name === "API_RATE_LIMITER"),
  "rate limiter binding is missing",
);
if (errors.length) {
  console.error(`Release config FAILED:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log("Release config passed.");
