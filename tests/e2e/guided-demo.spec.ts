import { expect, type Page, test } from "@playwright/test";
import { clientAddress, expectNoAxeViolations, launchDemo } from "./helpers";

// P8.1: the single guided demo, end to end through the screens a visitor uses, with the recap,
// reset, keyboard path and the offline fallback. E2E-28: the public evidence page.
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(clientAddress());
});

const checklist = (page: Page) => page.getByRole("list", { name: "Guided demo steps" });
const stepLink = (page: Page, n: number) =>
  checklist(page).getByRole("link", { name: new RegExp(`for step ${n}$`) });
const backToDemo = async (page: Page) => {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: /Guided demo/ })
    .click();
  await expect(page.getByRole("heading", { name: "Your checklist" })).toBeVisible();
};
const progressText = (page: Page, text: string) =>
  expect(page.getByRole("status").filter({ hasText: text })).toBeVisible();

test("P8.1 a first visitor finishes the five steps, sees the recap and resets", async ({
  page,
}) => {
  const started = Date.now();
  await launchDemo(page);
  await progressText(page, "1 of 5 steps done.");
  await page.getByRole("button", { name: "Use the Manager role" }).click();
  await expect(page.getByRole("button", { name: "Use the Manager role" })).toHaveCount(0);
  await expectNoAxeViolations(page);

  // Step 2: create a case.
  await stepLink(page, 2).click();
  await expect(page.getByRole("heading", { name: "Cases", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New case" }).click();
  await page.getByLabel("Case title").fill("Guided demo case");
  await page.getByRole("button", { name: "Create case" }).click();
  await expect(page.getByRole("heading", { name: "Guided demo case" })).toBeVisible();
  await backToDemo(page);
  await progressText(page, "2 of 5 steps done.");

  // Step 3: a simulated sync finds a mismatch.
  await stepLink(page, 3).click();
  const erp = page.getByRole("region", { name: "ERP Simulator" });
  await erp.getByLabel("Scenario").selectOption({ label: "Customer renamed" });
  await erp.getByRole("button", { name: "Run simulated sync" }).click();
  await expect(erp.getByText(/Last run: succeeded/)).toBeVisible();
  await backToDemo(page);
  await progressText(page, "3 of 5 steps done.");

  // Step 4: review a fixture document and decide.
  await stepLink(page, 4).click();
  const row = page.locator("tbody tr", { hasText: "Yours" }).filter({ hasText: "Intake" }).first();
  await row.getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Documents and AI review" })).toBeVisible();
  const select = page.getByLabel("Attach a fictional document");
  const value = await select
    .locator("option", { hasText: /\(complete\)/ })
    .first()
    .getAttribute("value");
  await select.selectOption(value as string);
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(page.getByText("Document attached.")).toBeVisible();
  await page.getByRole("button", { name: "Request review" }).click();
  await expect(page.getByText("Deterministic demonstration fixture").first()).toBeVisible();
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(
    page.getByText("Rejected. Nothing on the case changed.", { exact: true }),
  ).toBeVisible();
  await backToDemo(page);
  await progressText(page, "4 of 5 steps done.");

  // Step 5: approve a Ready case.
  await stepLink(page, 5).click();
  const ready = page.locator("tbody tr", { hasText: "Yours" }).filter({ hasText: "Ready" }).first();
  await ready.getByRole("link").click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".facts .chip").first()).toContainText("Approved");
  await backToDemo(page);
  await progressText(page, "All five steps are done.");

  const recap = page.getByRole("region", { name: "Recap" });
  await expect(recap.getByText(/All five steps done in/)).toBeVisible();
  await expect(recap.getByText("1 case created, each with an activity history.")).toBeVisible();
  await expect(recap.getByText(/Sources: Simulated/)).toBeVisible();
  await expect(recap.getByText(/Document review: Deterministic fixture/)).toBeVisible();
  await expect(recap.getByText(/Automation delivery: Simulated/)).toBeVisible();
  await expect(recap.getByText(/Nothing on this page is a measurement/)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Delivered");
  await expectNoAxeViolations(page);
  test.info().annotations.push({
    type: "timed-run",
    description: `scripted first-visitor run ${Math.round((Date.now() - started) / 1000)} s`,
  });

  await page.getByRole("button", { name: "Reset Demo" }).click();
  await page.getByRole("button", { name: "Confirm reset" }).click();
  await expect(page.getByText("Demo reset. The checklist starts over")).toBeVisible();
  await progressText(page, "1 of 5 steps done.");
  await expect(page.getByRole("region", { name: "Recap" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your checklist" })).toBeFocused();
});

test("P8.1 the checklist and reset work from the keyboard alone", async ({ page }, info) => {
  test.skip(Boolean(info.project.use.isMobile), "keyboard path runs on desktop");
  await launchDemo(page);
  await progressText(page, "1 of 5 steps done.");
  const link = stepLink(page, 2);
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Cases", level: 1 })).toBeVisible();
  await page.goBack();
  const reset = page.getByRole("button", { name: "Reset Demo" });
  await reset.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Confirm reset" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Your checklist" })).toBeFocused();
  await progressText(page, "1 of 5 steps done.");
});

test("P8.1 if progress can't load, the steps and links still work, and Retry recovers", async ({
  page,
}) => {
  await launchDemo(page);
  await page.route("**/api/v1/demo/progress", (route) => route.abort());
  await page.reload();
  await progressText(page, "Progress couldn't load. The steps below still work.");
  await expect(checklist(page).getByText("Unknown").first()).toBeVisible();
  await expect(stepLink(page, 3)).toHaveAttribute("href", "/app/integrations");
  await expect(page.getByRole("heading", { name: "If a provider is offline" })).toBeVisible();
  await page.unroute("**/api/v1/demo/progress");
  await page.getByRole("button", { name: "Retry" }).click();
  await progressText(page, "1 of 5 steps done.");
});

test("E2E-28 a visitor reads the engineering evidence with no session and no admin data", async ({
  page,
}) => {
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) calls.push(r.url());
  });
  await page.goto("/about/engineering");
  await expect(page.getByRole("heading", { name: "Engineering evidence", level: 1 })).toBeVisible();
  await expect(page.getByRole("table", { name: "Test results" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What is simulated or pending" })).toBeVisible();
  await expect(page.getByText(/is not NetSuite/)).toBeVisible();
  await expect(page.getByText(/No language model is called/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Written walkthrough" })).toBeVisible();
  await expect(page.locator("a[href^='/admin']")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(
    /owner subject|allowlist|IP_HASH_KEY|TOKEN_ENCRYPTION|bearer/i,
  );
  expect(calls).toEqual([]);
  await expectNoAxeViolations(page);
});

test("P8.1 New case stays put while the assignee filter fills (WebKit intermittent)", async ({
  page,
}) => {
  await launchDemo(page);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/v1/assignees", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/app/cases");
  const button = page.getByRole("button", { name: "New case" });
  await expect(button).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  const before = await button.boundingBox();
  release();
  await expect(page.getByLabel("Assignee").locator("option")).not.toHaveCount(2);
  const after = await button.boundingBox();
  expect(after).toEqual(before);
});
