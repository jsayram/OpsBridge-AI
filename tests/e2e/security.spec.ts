import { expect, test } from "@playwright/test";
import { clientAddress, openOverview } from "./helpers";

// P7.2: stored XSS through the real UI. A visitor's own text comes back as text in every place
// the app shows it, and the CSP would stop a script even if rendering ever slipped.
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(clientAddress());
});

const PAYLOADS = [
  `<img src=x onerror="window.__xss='img'">`,
  `<script>window.__xss='script'</script>`,
  `"><svg onload="window.__xss='svg'">`,
];

test("stored XSS in a case title renders as text and runs nothing", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await openOverview(page);
  for (const title of PAYLOADS) {
    await page.goto("/app/cases");
    await page.getByRole("button", { name: "New case" }).click();
    await page.getByLabel("Case title").fill(title);
    await page.getByLabel("Case type").selectOption("Billing");
    await page.getByRole("button", { name: "Create case" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  await page.goto("/app/cases");
  for (const title of PAYLOADS) await expect(page.getByText(title, { exact: true })).toBeVisible();
  await page.goto("/app/reports");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: string }).__xss),
  ).toBeUndefined();
  expect(await page.locator("img[src='x'], svg[onload]").count()).toBe(0);
  // Nothing tried to run, so the CSP had nothing to refuse.
  expect(violations).toEqual([]);
});

test("the page CSP allows no inline or remote script", async ({ page }) => {
  const res = await page.goto("/");
  const csp = res?.headers()["content-security-policy"] ?? "";
  const script = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? csp;
  expect(csp).toContain("default-src 'self'");
  expect(script).not.toContain("'unsafe-inline'");
  expect(script).not.toContain("'unsafe-eval'");
  expect(script).not.toMatch(/https?:|\*/);
  expect(csp).toContain("object-src 'none'");
});
