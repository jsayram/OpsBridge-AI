import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { importJWK, SignJWT } from "jose";

export const clientAddress = () => ({
  "cf-connecting-ip": `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join(".")}`,
});

export async function launchDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Launch Guided Demo" }).click();
  await expect(page.getByText("Your workspace is ready.")).toBeVisible({ timeout: 15_000 });
}

export async function openOverview(page: Page) {
  await launchDemo(page);
  await page.getByRole("link", { name: "Go to Overview" }).click();
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
}

export async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
}

export async function ownerToken(iat?: number) {
  const { privateJwk, subject } = JSON.parse(readFileSync(".wrangler/e2e/identity.json", "utf8"));
  const key = await importJWK(privateJwk, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "double-1" })
    .setIssuer("https://local-test-double.invalid")
    .setAudience("opsbridge-local-test-double")
    .setSubject(subject)
    .setIssuedAt(iat ?? now)
    .setExpirationTime(now + 300)
    .sign(key);
}
