import { expect, type Page, test } from "@playwright/test";
import { clientAddress, expectNoAxeViolations, openOverview } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(clientAddress());
});

const role = async (page: Page, name: "viewer" | "analyst" | "manager") => {
  await page.getByLabel("Demo role (simulation)").selectOption(name);
  await expect(page.getByText(`Role changed to ${name}.`).first()).toBeAttached();
};

test("P4: an approval becomes a Simulated run, and a rule is reused for the second team", async ({
  page,
}) => {
  await openOverview(page);
  await role(page, "manager");
  await page.goto("/app/automations");
  await expect(page.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();
  await expect(page.getByText("No events yet.")).toBeVisible();
  const rules = page.getByRole("table").first();
  await expect(rules.getByText("team is Field Services and decision is approved")).toBeVisible();
  await rules.getByRole("button", { name: "Reuse for Seasonal Staffing" }).click();
  await expect(rules.getByText("team is Seasonal Staffing and decision is approved")).toBeVisible();
  await expect(rules.getByText(/reused from another team's rule/)).toBeVisible();

  // The preview matches the reused rule and sends nothing.
  await page.getByLabel("Team").selectOption("Seasonal Staffing");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText(/Matches: .*for Seasonal Staffing\./)).toBeVisible();

  await page.goto("/app/cases");
  const row = page.locator("tbody tr", { hasText: "Yours" }).filter({ hasText: "Ready" }).first();
  await row.getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Next step" })).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".facts .chip").first()).toContainText("Approved");

  await page.goto("/app/automations");
  const runs = page.getByRole("table").last();
  await expect(runs.getByText("approval.completed")).toBeVisible();
  await expect(runs.getByText("Simulated", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Delivered");
  await runs.getByRole("button", { name: "Show attempts" }).first().click();
  await expect(runs.getByText(/Attempt 1: simulated/)).toBeVisible();
  await expectNoAxeViolations(page);
});

test("P4: viewers see rules and runs but no change controls", async ({ page }) => {
  await openOverview(page);
  await page.goto("/app/automations");
  await expect(page.getByRole("heading", { name: "Rules" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Turn off|Reuse for/ })).toHaveCount(0);
  await expectNoAxeViolations(page);
});
