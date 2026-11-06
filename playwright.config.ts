import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  workers: 2,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:8788",
    trace: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://localhost:8788/health/live",
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
  },
});
