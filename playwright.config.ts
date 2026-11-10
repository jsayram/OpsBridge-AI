import { defineConfig, devices } from "@playwright/test";

// The WebKit run serves https (see scripts/e2e-server.mjs). Chromium keeps plain http.
const https = process.env.E2E_WEBKIT === "1";
const origin = `${https ? "https" : "http"}://localhost:8788`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  workers: 2,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: origin,
    ignoreHTTPSErrors: https,
    trace: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    // P7.4: Safari's engine on desktop and iPhone. WebKit is a separate download, so these run
    // when E2E_WEBKIT=1 (npm run test:e2e:webkit). Playwright's WebKit is close to Safari but is
    // not Safari itself; the browser matrix in docs/reports/P7.4.md says so.
    ...(process.env.E2E_WEBKIT === "1"
      ? [
          {
            name: "webkit-desktop",
            use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } },
          },
          { name: "webkit-iphone", use: { ...devices["iPhone 15"] } },
        ]
      : []),
  ],
  webServer: {
    command: `${https ? "E2E_HTTPS=1 " : ""}node scripts/e2e-server.mjs`,
    url: `${origin}/health/live`,
    ignoreHTTPSErrors: https,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
  },
});
