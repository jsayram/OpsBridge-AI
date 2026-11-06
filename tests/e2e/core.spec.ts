import { expect, type Page, test } from "@playwright/test";
import { clientAddress, expectNoAxeViolations, openOverview } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(clientAddress());
});

const toCases = async (page: Page) => {
  await page.goto("/app/cases");
  await expect(page.getByRole("heading", { name: "Cases", level: 1 })).toBeVisible();
};

const openPackCase = async (page: Page, status: string) => {
  await toCases(page);
  const row = page.locator("tbody tr", { hasText: "Yours" }).filter({ hasText: status }).first();
  await row.getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Next step" })).toBeVisible();
};

const role = async (page: Page, name: "viewer" | "analyst" | "manager") => {
  await page.getByLabel("Demo role (simulation)").selectOption(name);
  await expect(page.getByText(`Role changed to ${name}.`).first()).toBeAttached();
};

const finishChecklist = async (page: Page) => {
  for (const label of ["Client contact confirmed", "Scope of work confirmed"]) {
    await page.getByLabel(`State of ${label}`).selectOption("done");
    await expect(page.getByText(`${label} updated.`)).toBeVisible();
    await expect(page.getByLabel(`State of ${label}`)).toBeEnabled();
  }
};

const status = (page: Page, text: string) =>
  expect(page.locator(".facts .chip").first()).toContainText(text);

test("P2-A and P2-C a case runs its whole life and survives a refresh", async ({ page }) => {
  await openOverview(page);
  await toCases(page);
  await page.getByRole("button", { name: "New case" }).click();
  await page.getByLabel("Case title").fill("Spring crew paperwork");
  await page.getByLabel("Case type").selectOption("Billing");
  await page.getByRole("button", { name: "Create case" }).click();
  await expect(page.getByRole("heading", { name: "Spring crew paperwork" })).toBeVisible();
  await status(page, "Intake");

  await page.getByRole("button", { name: "Send to review" }).click();
  await expect(page.getByRole("alert")).toContainText("Answer or flag every required");

  await finishChecklist(page);
  await page.getByLabel("State of Billing entity confirmed").selectOption("flagged");
  await expect(page.getByText("Billing entity confirmed updated.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send to review" })).toBeEnabled();
  await page.getByRole("button", { name: "Send to review" }).click();
  await status(page, "Needs Review");

  await role(page, "manager");
  await page.getByRole("button", { name: "Mark Ready" }).click();
  await expect(page.getByRole("alert")).toContainText("Finish or clear every required");
  await page.getByLabel("State of Billing entity confirmed").selectOption("done");
  await expect(page.getByText("Billing entity confirmed updated.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark Ready" })).toBeEnabled();
  await page.getByRole("button", { name: "Mark Ready" }).click();
  await status(page, "Ready");

  await page.getByRole("button", { name: "Approve" }).click();
  await status(page, "Approved");
  await page.getByRole("button", { name: "Close case" }).click();
  await status(page, "Closed");

  await page.reload();
  await status(page, "Closed");
  await expect(page.getByText("approval.completed", { exact: false })).toBeVisible();

  await page.getByLabel("Reason", { exact: true }).fill("New evidence arrived");
  await page.getByRole("button", { name: "Reopen case" }).click();
  await status(page, "Needs Review");
  await expect(page.getByText("New evidence arrived")).toBeVisible();
  await expectNoAxeViolations(page);
});

test("P2-B a stale edit is refused and explained, and Reload recovers", async ({
  page,
  context,
}) => {
  await openOverview(page);
  await openPackCase(page, "Intake");
  const other = await context.newPage();
  await other.setExtraHTTPHeaders(clientAddress());
  await other.goto(page.url());
  await other.getByLabel("Title").fill("Saved first");
  await other.getByRole("button", { name: "Save title" }).click();
  await expect(other.getByRole("heading", { name: "Saved first" })).toBeVisible();

  await page.getByLabel("Title").fill("Saved second");
  await page.getByRole("button", { name: "Save title" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Someone changed this case");
  await expect(alert).toContainText("Request ID");
  await expectNoAxeViolations(page);
  await alert.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByRole("heading", { name: "Saved first" })).toBeVisible();
  await page.getByLabel("Title").fill("Saved second");
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(page.getByRole("heading", { name: "Saved second" })).toBeVisible();
});

test("P2-B a role that can't act sees why, and nothing to press", async ({ page }) => {
  await openOverview(page);
  await role(page, "viewer");
  await openPackCase(page, "Ready");
  await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
  await expect(page.getByText("Needs the Manager role.")).toBeVisible();
  await expect(page.getByLabel("State of Client contact confirmed")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Hand off" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save title" })).toHaveCount(0);
  await role(page, "analyst");
  await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
  await role(page, "manager");
  await expect(page.getByRole("button", { name: "Approve" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Reject" })).toBeDisabled();
  await page.getByLabel("Reason", { exact: true }).fill("Signature missing");
  await page.getByRole("button", { name: "Reject" }).click();
  await status(page, "Needs Review");
});

test("JOB-TEST-02 handoff with a flagged item persists, and an observer is refused", async ({
  page,
}) => {
  await openOverview(page);
  await openPackCase(page, "Needs Review");
  await page
    .getByLabel("Hand off to")
    .selectOption({ label: "Rae Lindqvist, observer (fictional)" });
  await page.getByLabel("Handoff reason").fill("Trying the observer");
  await page.getByRole("button", { name: "Hand off" }).click();
  await expect(page.getByRole("alert")).toContainText("can't take this case");

  await page.getByLabel("Hand off to").selectOption({ label: "Marcus Vale (fictional)" });
  await page.getByLabel("Handoff reason").fill("Going on leave");
  await page.getByRole("button", { name: "Hand off" }).click();
  await expect(page.getByText("Case handed off.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Marcus Vale (fictional)").first()).toBeVisible();
  await expect(page.getByText("Going on leave").first()).toBeVisible();
  await expect(page.getByText("1 required item open")).toBeVisible();
});

test("list search, filters, empty state and a shared read-only case", async ({ page }) => {
  await openOverview(page);
  await toCases(page);
  await page.getByLabel("Search title or client").fill("no such thing");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("heading", { name: "No cases match" })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(page.getByRole("heading", { name: "No cases match" })).toHaveCount(0);

  await page.getByLabel("Status").selectOption("Closed");
  await expect(page.locator("tbody tr").first()).toContainText("Shared, read-only");
  await page.getByLabel("Overdue only").check();
  await expect(page.getByRole("heading", { name: "No cases match" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filter" }).click();

  await page.getByLabel("Status").selectOption("Ready");
  const shared = page.locator("tbody tr", { hasText: "Shared, read-only" }).first();
  await shared.getByRole("link").click();
  await expect(
    page.getByText("Shared sample case, read-only for every visitor.").first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test("the new-case form and keyboard path pass axe", async ({ page }) => {
  await openOverview(page);
  await toCases(page);
  await page.getByRole("button", { name: "New case" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Case title")).toBeVisible();
  await expectNoAxeViolations(page);
});
