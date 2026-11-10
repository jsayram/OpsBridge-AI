import { test } from "@playwright/test";
import { clientAddress, openOverview } from "./helpers";

// Evidence screenshots for reports. Runs only when asked: EVIDENCE=1 npx playwright test evidence
test.skip(!process.env.EVIDENCE, "evidence run only");

test("screens", async ({ page }, info) => {
  await page.setExtraHTTPHeaders(clientAddress());
  const shot = (name: string) =>
    page.screenshot({
      path: `docs/evidence/P1.4/${name}-${info.project.name}.jpg`,
      type: "jpeg",
      quality: 70,
      fullPage: true,
    });
  await page.goto("/");
  await shot("landing");
  await openOverview(page);
  await page.waitForLoadState("networkidle");
  await shot("overview");
  await page.getByRole("link", { name: "Cases" }).first().click();
  await page.locator("tbody tr").first().waitFor();
  await shot("cases");
});
