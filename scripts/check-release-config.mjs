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
const text = readFileSync(file, "utf8");
const errors = [];
const need = (ok, message) => {
  if (!ok) errors.push(message);
};
need(!/local-test-double/.test(text), "test identity double in a release config");
need(!/OWNER_TEST_JWKS/.test(text), "test double keys in a release config");
need(!/localConnectionString/.test(text), "local database connection");
need(!/local_dev_only/.test(text), "local password");
need(!/REPLACE_/.test(text), "unfilled placeholder");
need(!/0{31}[12]/.test(text), "placeholder Hyperdrive ID");
need(!/"ENVIRONMENT":\s*"local"/.test(text), "ENVIRONMENT is local");
need(
  /"ENVIRONMENT":\s*"(staging|production)"/.test(text),
  "ENVIRONMENT must be staging or production",
);
need(/"APP_ORIGIN":\s*"https:\/\//.test(text), "APP_ORIGIN must be an https origin");
need(/"compatibility_date":\s*"\d{4}-\d{2}-\d{2}"/.test(text), "pinned compatibility date");
need(
  !/DEMO_(LAUNCH_HOURLY_LIMIT|WORKSPACE_CAP|TTL_SECONDS|RESET_LIMIT)/.test(text),
  "quota override",
);
if (errors.length) {
  console.error(`Release config FAILED:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log("Release config passed.");
