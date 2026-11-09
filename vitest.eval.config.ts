import { defineConfig } from "vitest/config";

// P5.5: the fixed 40-document evaluation, run through the real API against its own database.
process.env.OPSBRIDGE_TEST_DB = "opsbridge_eval_test";
export default defineConfig({
  test: {
    include: ["tests/eval/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup/no-network.ts"],
    globalSetup: ["tests/eval/global-setup.mjs"],
    fileParallelism: false,
    testTimeout: 120_000,
    env: { OPSBRIDGE_TEST_DB: "opsbridge_eval_test" },
  },
});
