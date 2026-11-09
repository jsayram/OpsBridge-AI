import { defineConfig } from "vitest/config";

// Real Postgres, real migrations, in-process Hono. Hyperdrive is not in the path.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup/no-network.ts"],
    globalSetup: ["tests/integration/global-setup.mjs"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
