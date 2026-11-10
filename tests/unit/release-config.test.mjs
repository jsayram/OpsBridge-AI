import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "release-config-"));
const good = () => ({
  compatibility_date: "2026-10-01",
  assets: { run_worker_first: ["/api/*", "/health/*", "/admin", "/admin/*"] },
  vars: {
    ENVIRONMENT: "staging",
    APP_ORIGIN: "https://stage.example.com",
    OWNER_IDENTITY_MODE: "access",
  },
  hyperdrive: [
    { binding: "HYPERDRIVE", id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { binding: "HYPERDRIVE_CLEANUP", id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    { binding: "HYPERDRIVE_DISPATCH", id: "cccccccccccccccccccccccccccccccc" },
  ],
  ratelimits: [{ name: "API_RATE_LIMITER" }],
  triggers: { crons: ["*/30 * * * *"] },
});
const check = (config, name) => {
  const file = join(dir, `${name}.jsonc`);
  writeFileSync(
    file,
    `// a comment that mentions REPLACE_ is fine\n${JSON.stringify(config, null, 2)}\n`,
  );
  return spawnSync("node", ["scripts/check-release-config.mjs", file], { encoding: "utf8" });
};

describe("release config gate", () => {
  it("passes a complete config, ignoring comments", () => {
    expect(check(good(), "good").status).toBe(0);
  });
  it.each([
    [
      "test double",
      (c) => {
        c.vars.OWNER_IDENTITY_MODE = "local-test-double";
      },
    ],
    [
      "local environment",
      (c) => {
        c.vars.ENVIRONMENT = "local";
      },
    ],
    [
      "http origin",
      (c) => {
        c.vars.APP_ORIGIN = "http://stage.example.com";
      },
    ],
    [
      "placeholder",
      (c) => {
        c.vars.ACCESS_AUD = "REPLACE_ME";
      },
    ],
    [
      "admin not worker-first",
      (c) => {
        c.assets.run_worker_first = ["/api/*", "/health/*"];
      },
    ],
    [
      "no cron",
      (c) => {
        c.triggers.crons = [];
      },
    ],
    [
      "shared Hyperdrive",
      (c) => {
        c.hyperdrive[1].id = c.hyperdrive[0].id;
      },
    ],
    [
      "dispatcher shares the request role's Hyperdrive",
      (c) => {
        c.hyperdrive[2].id = c.hyperdrive[0].id;
      },
    ],
    [
      "no dispatcher binding",
      (c) => {
        c.hyperdrive.pop();
      },
    ],
    [
      "no cleanup binding",
      (c) => {
        c.hyperdrive.pop();
      },
    ],
    [
      "no limiter",
      (c) => {
        c.ratelimits = [];
      },
    ],
    [
      "local connection",
      (c) => {
        c.hyperdrive[0].localConnectionString = "x";
      },
    ],
  ])("refuses %s", (name, mutate) => {
    const config = good();
    mutate(config);
    expect(check(config, name.replaceAll(" ", "-")).status).toBe(1);
  });
  it("refuses the unfilled template and the local config", () => {
    for (const f of ["infra/wrangler.staging.template.jsonc", "wrangler.jsonc"]) {
      const r = spawnSync("node", ["scripts/check-release-config.mjs", f], { encoding: "utf8" });
      expect(r.status).toBe(1);
    }
  });
});
