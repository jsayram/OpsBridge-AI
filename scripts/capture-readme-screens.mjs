// Captures the README screenshots from a running local demo.
// Usage: start the app (`npm run dev`), then `node scripts/capture-readme-screens.mjs [baseUrl]`.
// Every screen shows synthetic data. Nothing here calls an outside service.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:8787";
const out = join(import.meta.dirname, "..", "docs", "screenshots");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const shot = async (name, { full = false } = {}) => {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({
    path: join(out, `${name}.jpg`),
    type: "jpeg",
    quality: 82,
    fullPage: full,
  });
  console.log(`saved ${name}.jpg`);
};
const step = async (label, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log(`skipped ${label}: ${e.message.split("\n")[0]}`);
  }
};
const go = (path) => page.goto(base + path);

await step("landing", async () => {
  await go("/");
  await shot("01-landing");
});
await step("demo", async () => {
  await page.getByRole("button", { name: "Launch Guided Demo" }).click();
  await page.getByText("Your workspace is ready").waitFor({ timeout: 30000 });
  await shot("02-guided-demo", { full: true });
});
await step("overview", async () => {
  await go("/app/overview");
  await shot("03-overview");
});
await step("cases", async () => {
  await go("/app/cases");
  await shot("04-cases");
});
await step("sync", async () => {
  await go("/app/integrations");
  const erp = page.getByRole("region", { name: "ERP Simulator" });
  await erp.getByRole("combobox").selectOption({ label: "Customer renamed" });
  await erp.getByRole("button", { name: "Run simulated sync" }).click();
  await page.waitForTimeout(1500);
  await shot("05-integrations");
});
await step("reconciliation", async () => {
  await go("/app/reconciliation");
  await shot("06-reconciliation");
  await page.getByRole("link", { name: "Definition conflict" }).first().click();
  await page.waitForURL("**/app/reconciliation/**");
  await shot("07-definition-conflict", { full: true });
});
await step("document review", async () => {
  await go("/app/cases");
  await page.getByText(/cases shown/).waitFor({ timeout: 30000 });
  const href = await page
    .getByRole("row")
    .filter({ hasText: "Intake" })
    .filter({ hasText: "Yours" })
    .first()
    .getByRole("link")
    .first()
    .getAttribute("href");
  await go(href);
  await page.locator("#documents-heading").waitFor({ timeout: 30000 });
  const docs = page.locator("section", { has: page.locator("#documents-heading") });
  await docs.getByRole("list").getByRole("button").first().click();
  await page.getByRole("button", { name: /Request review|Review again/ }).click();
  await page
    .getByRole("region", { name: "Suggested fields and sources" })
    .waitFor({ timeout: 30000 });
  await page.locator("#documents-heading").scrollIntoViewIfNeeded();
  await shot("08-document-review", { full: true });
});
await step("automations", async () => {
  await go("/app/automations");
  await shot("09-automations");
});
await step("analytics", async () => {
  await go("/app/analytics");
  await shot("10-analytics", { full: true });
});
await step("reports", async () => {
  await go("/app/reports");
  await shot("11-reports");
});
await step("roi", async () => {
  await go("/app/roi");
  await shot("12-roi", { full: true });
});
await step("inventory", async () => {
  await go("/app/inventory");
  await shot("13-inventory");
});
await step("engineering", async () => {
  await go("/about/engineering");
  await shot("14-engineering-evidence");
});

await browser.close();
