import { defineConfig } from "vitest/config";

// P2-D. Own database, because 1,000 extra owner cases would change what other tests see.
export default defineConfig({
  test: {
    include: ["tests/profile/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup/no-network.ts"],
    env: { OPSBRIDGE_TEST_DB: "opsbridge_profile_test" },
    globalSetup: ["tests/profile/global-setup.mjs"],
    testTimeout: 120_000,
  },
});
