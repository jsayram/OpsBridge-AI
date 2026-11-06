import { expect, type Page, test } from "@playwright/test";
import { clientAddress, expectNoAxeViolations, openOverview } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(clientAddress());
});

const role = async (page: Page, name: "viewer" | "analyst" | "manager") => {
  await page.getByLabel("Demo role (simulation)").selectOption(name);
  await expect(page.getByText(`Role changed to ${name}.`).first()).toBeAttached();
};

const card = (page: Page, name: string) => page.getByRole("region", { name });

const syncSource = async (page: Page, name: string, scenario?: string) => {
  const source = card(page, name);
  if (scenario) await source.getByLabel("Scenario").selectOption({ label: scenario });
  await source.getByRole("button", { name: "Run simulated sync" }).click();
};

test("the showcase: a reviewer maps one CRM organization to two ERP bill-tos", async ({ page }) => {
  await openOverview(page);
  await role(page, "manager");
  await page.goto("/app/reconciliation");
  await page.getByRole("link", { name: "Definition conflict" }).click();
  await expect(page.getByRole("heading", { name: "Source evidence" })).toBeVisible();
  await expect(page.getByText("billable legal entity")).toBeVisible();
  await expect(page.getByText("Harbor Ridge Holdings Inc. (fictional)")).toBeVisible();
  await expect(page.getByText("Harbor Ridge Packing LLC (fictional)")).toBeVisible();
  await expect(page.getByText("Simulated").first()).toBeVisible();
  await page.getByRole("button", { name: "Start investigating" }).click();
  await page.getByLabel("What you propose").fill("One organization, two billable entities.");
  await page.getByRole("button", { name: "Propose resolution" }).click();
  await page.getByRole("button", { name: "Approve resolution" }).click();
  await expect(page.getByText(/Resolved by manager/)).toBeVisible();
  await expect(page.getByText("Mapped 2 bill-tos under one customer.")).toBeVisible();
});

test("a sync runs, a replay adds nothing, and a fault recovers from its saved cursor", async ({
  page,
}) => {
  await openOverview(page);
  await role(page, "manager");
  await page.goto("/app/integrations");
  const erp = card(page, "ERP Simulator");
  await expect(erp.getByText("Never synced")).toBeVisible();
  await syncSource(page, "ERP Simulator");
  await expect(erp.getByText(/17 seen, 17 new/)).toBeVisible();
  await expect(erp.getByText("Fresh, within a day")).toBeVisible();
  await syncSource(page, "ERP Simulator", "Outage (500 until resumed)");
  await expect(erp.getByText(/Failed safely/)).toBeVisible({ timeout: 15_000 });
  await expect(erp.getByText("Degraded")).toBeVisible();
  await expect(erp.getByText("http_500")).toBeVisible();
  await erp.getByRole("button", { name: "Resume from saved cursor" }).click();
  await expect(erp.getByText(/Last run: succeeded/)).toBeVisible();
  await expect(erp.getByText("Degraded")).toHaveCount(0);
  await syncSource(page, "ERP Simulator", "Credentials revoked (401)");
  await expect(erp.getByText(/Needs an operator/)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("INVALID_LOGIN");
});

test("a renamed ERP customer opens a finding with both values and changes no customer", async ({
  page,
}) => {
  await openOverview(page);
  await role(page, "manager");
  await page.goto("/app/integrations");
  await syncSource(page, "ERP Simulator", "Customer renamed");
  await expect(card(page, "ERP Simulator").getByText(/Last run: succeeded/)).toBeVisible();
  await page.goto("/app/reconciliation");
  await page.getByLabel("Status").selectOption("Open");
  await page.getByRole("link", { name: "Name mismatch" }).first().click();
  await expect(page.getByText(/Cedar Point Outdoor Services/).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "What differs" })).toBeVisible();
  await expect(page.getByRole("link", { name: /replaces/ })).toBeVisible();
});

test("inventory is read-only and labeled, and unknown items stay unknown", async ({ page }) => {
  await openOverview(page);
  await role(page, "manager");
  await page.goto("/app/integrations");
  await syncSource(page, "Inventory (simulated)");
  await expect(card(page, "Inventory (simulated)").getByText(/Last run: succeeded/)).toBeVisible();
  await page.goto("/app/inventory");
  await expect(page.getByRole("heading", { name: "Inventory", level: 1 })).toBeVisible();
  await expect(page.getByText("Read-only facts from a simulated source")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Not matched to an item" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "SKU-998" })).toBeVisible();
  await expect(page.getByRole("button")).not.toContainText(["Order", "Reserve", "Adjust"]);
});

test("a viewer can read every integration page and can't act", async ({ page }) => {
  await openOverview(page);
  await role(page, "viewer");
  await page.goto("/app/integrations");
  await expect(page.getByRole("button", { name: "Run simulated sync" })).toHaveCount(0);
  await page.goto("/app/reconciliation");
  await page.getByRole("link", { name: "Definition conflict" }).click();
  await expect(page.getByText("The Viewer role can't act here")).toBeVisible();
});

test("a case shows its source references, and a handoff can carry an item", async ({ page }) => {
  await openOverview(page);
  await role(page, "manager");
  await page.goto("/app/cases");
  const row = page.locator("tbody tr", { hasText: "Yours" }).filter({ hasText: "Intake" }).first();
  await row.getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Source references" })).toBeVisible();
  await page.getByLabel("Hand off to").selectOption({ label: "Seasonal Staffing queue" });
  await page.getByLabel("Inventory reference (optional)").selectOption({ index: 1 });
  await page.getByLabel("Handoff reason").fill("Needs the stock count");
  await page.getByRole("button", { name: "Hand off" }).click();
  await expect(page.getByText(/Inventory reference SKU-100/)).toBeVisible();
});

test("the new pages pass axe, light and on a phone", async ({ page }) => {
  await openOverview(page);
  for (const path of ["/app/reconciliation", "/app/integrations", "/app/inventory"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("status", { name: /Loading/ })).toHaveCount(0);
    await expectNoAxeViolations(page);
  }
  await page.goto("/app/reconciliation");
  await page.getByRole("link", { name: "Definition conflict" }).click();
  await expect(page.getByRole("heading", { name: "Decision" })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByRole("heading", { name: "Decision" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
