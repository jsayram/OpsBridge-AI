import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { calculate, SCENARIOS, usd } from "../../frontend/src/lib/roi";
import { clientAddress, expectNoAxeViolations, openOverview } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(clientAddress());
});

const role = async (page: Page, name: "viewer" | "analyst" | "manager") => {
  await page.getByLabel("Demo role (simulation)").selectOption(name);
  await expect(page.getByText(`Role changed to ${name}.`).first()).toBeAttached();
};

type M = { key: string; value: number | null; unit: string };
const overview = async (page: Page) => {
  const res = await page.request.get("/api/v1/analytics/overview");
  expect(res.status()).toBe(200);
  return res.json();
};
const all = (o: any): M[] => [
  ...o.pulse,
  ...o.quality.metrics,
  ...o.ai.metrics,
  ...o.automation.metrics,
];

test("P6.2: every dashboard value matches its query, with labels, tables and no axe violations", async ({
  page,
}) => {
  await openOverview(page);
  await page.goto("/app/analytics");
  await expect(page.getByRole("heading", { name: "Analytics", level: 1 })).toBeVisible();
  for (const name of [
    "Operations pulse",
    "Workflow funnel",
    "Integration health",
    "Data quality",
    "AI assistance",
    "Automation",
  ]) {
    await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
  }
  const o = await overview(page);
  for (const m of all(o)) {
    if (m.unit !== "count" || m.value === null) continue;
    await expect(page.locator(`[data-metric="${m.key}"]`).first()).toHaveText(
      m.value.toLocaleString("en-US"),
    );
  }
  // Live cost is unknown, never shown as zero.
  await expect(page.locator('[data-metric="ai_live_cost"]')).toHaveText("Not available");
  await expect(page.getByText(/Live AI: Pending Owner Credentials/)).toBeVisible();
  await expect(page.getByText(/Fixture evaluation, not model accuracy/)).toBeVisible();
  // Every source row says Simulated; nothing says live or Delivered.
  const sourceRows = page.locator("table", { hasText: "Records" }).locator("tbody tr");
  const n = await sourceRows.count();
  expect(n).toBe(o.integration.sources.length);
  for (let i = 0; i < n; i++) await expect(sourceRows.nth(i)).toContainText("Simulated");
  await expect(page.locator("body")).not.toContainText("Delivered");
  // Funnel table equals the API.
  for (const s of o.funnel.stages) {
    const row = page.locator("table", { hasText: "Reached" }).locator("tbody tr", {
      hasText: s.status,
    });
    await expect(row.first().locator("td").first()).toHaveText(String(s.count));
  }
  await expectNoAxeViolations(page);
});

test("P6-E: key metrics are reachable as headings and the trend table opens from the keyboard", async ({
  page,
}) => {
  await openOverview(page);
  await page.goto("/app/analytics");
  await expect(
    page.getByRole("heading", { name: "Open cases", level: 3, exact: true }),
  ).toBeVisible();
  // What a screen reader reads for the first key metric: its heading, value and label.
  const card = page.locator(".kpi", {
    has: page.getByRole("heading", { name: "Open cases", exact: true }),
  });
  await expect(card).toMatchAriaSnapshot(`
    - heading "Open cases" [level=3]
    - paragraph: /\\d+/
    - paragraph: Synthetic
    - paragraph: /Intake, Needs Review or Ready/
  `);
  const summary = page.getByText(/Show the 90 daily values as a table/);
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("table", { name: /Open cases by day/ })).toBeVisible();
});

test("E2E-20: after an approval the dashboard agrees with the records again", async ({ page }) => {
  await openOverview(page);
  await role(page, "manager");
  const before = await overview(page);
  const done = (o: any) => o.pulse.find((m: M) => m.key === "completed_cases").value;
  await page.goto("/app/cases");
  const row = page.locator("tbody tr", { hasText: "Yours" }).filter({ hasText: "Ready" }).first();
  await row.getByRole("link").click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".facts .chip").first()).toContainText("Approved");
  await page.goto("/app/analytics");
  const after = await overview(page);
  expect(done(after)).toBe(done(before) + 1);
  await expect(page.locator('[data-metric="completed_cases"]')).toHaveText(String(done(after)));
  // Record today's snapshot: one row per metric, confirmed on screen.
  await page.getByRole("button", { name: "Record today's snapshot" }).click();
  await expect(page.getByText(/Recorded your values for/)).toBeVisible();
});

test("P6.3 / JOB-TEST-04: report filter, chart table and CSV agree", async ({
  page,
  browserName,
}) => {
  await openOverview(page);
  await page.goto("/app/reports");
  await expect(page.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();
  await page.getByRole("combobox", { name: /^Status/ }).selectOption("Closed");
  const heading = page.getByRole("heading", { name: /matching cases/ });
  await expect(heading).toHaveText(/^\d+ matching cases$/);
  const total = Number((await heading.textContent())?.split(" ")[0]);
  expect(total).toBeGreaterThan(0);
  await expect(page.locator('[data-status-count="Closed"]')).toHaveText(String(total));
  await expect(page.locator('[data-status-count="Intake"]')).toHaveText("0");
  const link = page.getByRole("link", { name: "Export CSV" });
  let text: string;
  if (browserName === "webkit") {
    // WebKit fetches a download in another process that ignores ignoreHTTPSErrors, so with the
    // local self-signed certificate the download never lands (P7.4). The same link, fetched in
    // the page with the same session, checks the same file; the save prompt itself is unchecked.
    text = await link.evaluate((a) => fetch((a as HTMLAnchorElement).href).then((r) => r.text()));
  } else {
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    text = readFileSync((await download.path()) as string, "utf8");
  }
  const lines = text.trimEnd().split("\r\n");
  expect(lines).toHaveLength(total + 1);
  expect(lines.slice(1).every((l) => l.includes('"Closed"') && l.endsWith('"SYNTHETIC"'))).toBe(
    true,
  );
  // An empty range explains itself.
  await page.getByLabel("From (UTC)").fill("2020-01-01");
  await page.getByLabel("To (UTC)").fill("2020-01-31");
  await expect(page.getByText(/No cases match these filters/)).toBeVisible();
  await expectNoAxeViolations(page);
});

test("P6.3: a viewer gets the report and the export, and no snapshot button", async ({ page }) => {
  await openOverview(page);
  await role(page, "viewer");
  await page.goto("/app/reports");
  await expect(page.getByRole("heading", { name: /matching cases/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Export CSV" })).toHaveCount(1);
  await page.goto("/app/analytics");
  await expect(page.getByRole("heading", { name: "Operations pulse" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record today's snapshot" })).toHaveCount(0);
});

test("E2E-19: changing ROI assumptions recalculates exactly and keeps the Estimated label", async ({
  page,
}) => {
  await openOverview(page);
  await page.goto("/app/roi");
  await expect(page.getByRole("heading", { name: "ROI calculator", level: 1 })).toBeVisible();
  const net = page.locator('[data-out="net"]');
  await expect(net).toHaveText(usd(calculate(SCENARIOS.base).netValue));
  await page.getByLabel(/Tasks per month/).fill("800");
  await expect(net).toHaveText(usd(calculate({ ...SCENARIOS.base, tasksPerMonth: 800 }).netValue));
  await page.getByLabel(/Hourly labor cost/).fill("50");
  await expect(net).toHaveText(
    usd(calculate({ ...SCENARIOS.base, tasksPerMonth: 800, hourlyLaborCost: 50 }).netValue),
  );
  await expect(
    page.getByText("Illustrative projection using synthetic workload").first(),
  ).toBeVisible();
  await expect(page.locator(".badge.prov.estimated").first()).toBeVisible();
  // Zero modeled cost: no ROI figure, no division by zero.
  await page.getByLabel(/Platform cost/).fill("0");
  await page.getByLabel(/Automation tool cost/).fill("0");
  await page.getByLabel(/AI cost per task/).fill("0");
  await expect(page.locator('[data-out="roi"]')).toHaveText(/Not defined/);
  // A bad input stops the projection instead of showing a wrong one.
  await page.getByLabel(/Exception rate/).fill("150");
  await expect(
    page.locator("p:not(.sr-only)", { hasText: "Fix the highlighted assumptions" }),
  ).toBeVisible();
  // The screen-reader live line says it once, instead of re-reading every figure.
  await expect(page.locator(".sr-only[aria-live]", { hasText: "Fix the highlighted" })).toHaveCount(
    1,
  );
  await page.getByRole("button", { name: "Load conservative" }).click();
  await expect(net).toHaveText(usd(calculate(SCENARIOS.conservative).netValue));
  await expectNoAxeViolations(page);
});
