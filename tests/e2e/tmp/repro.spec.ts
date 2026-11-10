import { expect, test } from "@playwright/test";
import { clientAddress, openOverview } from "../helpers";

test("repro search render error", async ({ page }) => {
  await page.setExtraHTTPHeaders(clientAddress());
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}\n${e.stack}`));
  await openOverview(page);
  for (let i = 0; i < 6; i++) {
    await page.goto("/app/cases");
    await expect(page.getByRole("heading", { name: "Cases", level: 1 })).toBeVisible();
    await page.getByLabel("Search title or client").fill("no such thing");
    await page.getByRole("button", { name: "Search" }).click();
    const ok = await page
      .getByRole("heading", { name: "No cases match" })
      .waitFor({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      console.log("FAILED at", i, JSON.stringify(errors, null, 1));
      throw new Error("repro");
    }
  }
});
