import { expect, type Page, test } from "@playwright/test";
import { clientAddress, expectNoAxeViolations, openOverview } from "./helpers";

// P5 in the browser: E2E-11 (reject changes nothing), E2E-12 (prompt injection), E2E-13 (upload
// refused for guests) and E2E-14 (no live AI for guests, fixture labeled).
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(clientAddress());
});

const role = async (page: Page, name: "viewer" | "analyst" | "manager") => {
  await page.getByLabel("Demo role (simulation)").selectOption(name);
  await expect(page.getByText(`Role changed to ${name}.`).first()).toBeAttached();
};

const openIntakeCase = async (page: Page) => {
  await page.goto("/app/cases");
  const row = page.locator("tbody tr", { hasText: "Yours" }).filter({ hasText: "Intake" }).first();
  await row.getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Documents and AI review" })).toBeVisible();
};

const attachAndReview = async (page: Page, fixtureLabel: RegExp) => {
  const select = page.getByLabel("Attach a fictional document");
  const value = await select
    .locator("option", { hasText: fixtureLabel })
    .first()
    .getAttribute("value");
  await select.selectOption(value as string);
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(page.getByText("Document attached.")).toBeVisible();
  await page.getByRole("button", { name: "Request review" }).click();
  await expect(page.getByText("Deterministic demonstration fixture").first()).toBeVisible();
};

test("E2E-11 a manager rejects a suggestion and the case doesn't change", async ({ page }) => {
  await openOverview(page);
  await role(page, "manager");
  await openIntakeCase(page);
  // Read only once the checklist has rendered (a WebKit run caught the race, P7.4).
  await expect(page.locator(".check-row select").first()).toBeVisible();
  const checklistBefore = await page
    .locator(".check-row select")
    .evaluateAll((s) => s.map((e) => (e as unknown as HTMLSelectElement).value));
  await attachAndReview(page, /\(complete\)/);
  await expect(page.getByRole("columnheader", { name: "Source in the document" })).toBeVisible();
  await expect(page.getByText(/Page 1, p1-s\d+/).first()).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByLabel("Reason (optional)").fill("Wrong client on the form");
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("Rejected. Nothing on the case changed.")).toBeVisible();
  // The case reloads after the decision, so poll until the checklist has rendered again.
  await expect
    .poll(() =>
      page
        .locator(".check-row select")
        .evaluateAll((s) => s.map((e) => (e as unknown as HTMLSelectElement).value)),
    )
    .toEqual(checklistBefore);
  await expect(page.getByText(/Decided: Rejected/)).toBeVisible();
});

test("E2E-12 an injected document is flagged, and accepting it only applies what the fields support", async ({
  page,
}) => {
  await openOverview(page);
  await role(page, "manager");
  await openIntakeCase(page);
  await attachAndReview(page, /prompt-injection/);
  await expect(
    page.getByText("The document contains text that reads like instructions.").first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^Accept/ })
    .first()
    .click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  // The case is still where it was: an injected "approve" did nothing.
  await expect(page.locator(".facts .chip").first()).toContainText("Intake");
});

test("E2E-14 a guest gets labeled fixture output, no live option, and an analyst can't decide", async ({
  page,
}) => {
  await openOverview(page);
  await role(page, "analyst");
  await openIntakeCase(page);
  await attachAndReview(page, /image-only/);
  await expect(page.getByText(/Abstained: no_extractable_text/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Live review/ })).toHaveCount(0);
  await expect(page.getByText("Only a Manager can decide a review.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reject" })).toHaveCount(0);
});

test("E2E-13 a guest can't upload a file, whatever it is", async ({ page }) => {
  await openOverview(page);
  await role(page, "manager");
  const caseId = await page.evaluate(async () => {
    const r = await fetch("/api/v1/cases?limit=1", { credentials: "same-origin" });
    const body = (await r.json()) as { items: { id: string }[] };
    return body.items[0]?.id as string;
  });
  const status = await page.evaluate(async (id) => {
    const r = await fetch(`/api/v1/cases/${id}/documents`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/pdf" },
      body: "%PDF-1.7 fake",
    });
    return [r.status, ((await r.json()) as { code: string }).code];
  }, caseId);
  expect(status).toEqual([403, "forbidden"]);
});
