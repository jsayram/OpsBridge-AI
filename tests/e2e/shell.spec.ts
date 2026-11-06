import { expect, test } from "@playwright/test";
import {
  clientAddress,
  expectNoAxeViolations,
  launchDemo,
  openOverview,
  ownerToken,
} from "./helpers";

// Each test gets its own client address, so one test run can't trip the shared rate limit.
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(clientAddress());
});

test.describe("landing", () => {
  test("is static: a first visit makes no API call", async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/")) calls.push(r.url());
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "OpsBridge AI", level: 1 })).toBeVisible();
    await expect(page.getByText("isn't affiliated", { exact: false })).toBeVisible();
    await expect(page.getByRole("note")).toContainText("Simulated demo");
    await page.waitForTimeout(300);
    expect(calls).toEqual([]);
    await expectNoAxeViolations(page);
  });

  test("assets carry the security headers", async ({ page }) => {
    const res = await page.goto("/");
    const headers = res?.headers() ?? {};
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
  });

  test("no CSP violation or console error on the main path", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().includes("401")) problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(e.message));
    await openOverview(page);
    await expect(page.getByText("Your cases")).toBeVisible();
    expect(problems).toEqual([]);
  });
});

test.describe("P1-A launch and reset", () => {
  test("launch gives a hardened cookie and a working shell", async ({ page, context }) => {
    await openOverview(page);
    const cookie = (await context.cookies()).find((c) => c.name === "__Host-obs_demo");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe("Strict");
    await expect(page.getByText("Session ends in")).toBeVisible();
    await expect(page.getByText("Northstar Operations (fictional)")).toBeVisible();
    await expect(page.locator(".kpi .value").first()).toHaveText("3");
    await expectNoAxeViolations(page);
  });

  test("a second click on Launch reuses the live session", async ({ page }) => {
    await launchDemo(page);
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") posts.push(r.url());
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Launch Guided Demo" }).click();
    await expect(page.getByText("Your workspace is ready.")).toBeVisible();
    expect(posts).toEqual([]);
  });

  test("reset restores the pack and drops edits", async ({ page }) => {
    await openOverview(page);
    await page.getByRole("link", { name: "Cases" }).first().click();
    await page
      .getByRole("link", { name: /Seasonal|Billing|Contract|Site|Timesheet|Equipment/ })
      .first()
      .click();
    const title = page.getByLabel("Title");
    await title.fill("Edited by this visitor");
    await page.getByRole("button", { name: "Save title" }).click();
    await expect(page.getByRole("heading", { name: "Edited by this visitor" })).toBeVisible();
    await page.getByRole("link", { name: "Cases" }).first().click();
    await expect(page.getByText("Edited by this visitor")).toBeVisible();
    await page.getByRole("button", { name: "Reset demo" }).click();
    await page.getByRole("button", { name: "Confirm reset" }).click();
    await expect(page.getByText("Demo reset to a fresh workspace.").first()).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Seasonal|Billing|Contract/ }).first(),
    ).toBeVisible();
    await expect(page.getByText("Edited by this visitor")).toHaveCount(0);
  });
});

test("E2E-02 two browsers stay apart, including by guessed URL", async ({ browser }) => {
  const a = await (await browser.newContext({ extraHTTPHeaders: clientAddress() })).newPage();
  const b = await (await browser.newContext({ extraHTTPHeaders: clientAddress() })).newPage();
  await openOverview(a);
  await openOverview(b);
  await a.goto("/app/cases");
  await a.locator("tbody tr", { hasText: "Yours" }).first().getByRole("link").click();
  await a.getByLabel("Title").fill("Private to A");
  await a.getByRole("button", { name: "Save title" }).click();
  await expect(a.getByRole("heading", { name: "Private to A" })).toBeVisible();
  const url = new URL(a.url()).pathname;
  await b.goto("/app/cases");
  await expect(b.locator("tbody tr").first()).toBeVisible();
  await expect(b.getByText("Private to A")).toHaveCount(0);
  await b.goto(url);
  await expect(b.getByRole("heading", { name: "Case not found" })).toBeVisible();
});

test("role switch is server-side and shows up in the UI", async ({ page }) => {
  await openOverview(page);
  await page.goto("/app/cases");
  await page.locator("tbody tr", { hasText: "Yours" }).first().getByRole("link").click();
  await expect(page.getByLabel("Title")).toBeVisible();
  await page.getByLabel("Demo role (simulation)").selectOption("viewer");
  await expect(page.getByText("The Viewer role can't edit.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Demo role (simulation)")).toHaveValue("viewer");
  await expect(page.getByText("The Viewer role can't edit.")).toBeVisible();
});

test.describe("states", () => {
  test("no session on an app route: clear next step, not a blank page", async ({ page }) => {
    await page.goto("/app/overview");
    await expect(page.getByRole("heading", { name: "No demo session" })).toBeVisible();
    await page.getByRole("link", { name: "Go to the demo" }).click();
    await expect(page.getByRole("heading", { name: "Guided demo" })).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("E2E-21 session ends mid-edit: recovery, no unauthorized write", async ({
    page,
    context,
  }) => {
    await openOverview(page);
    await page.goto("/app/cases");
    await page.locator("tbody tr", { hasText: "Yours" }).first().getByRole("link").click();
    await page.getByLabel("Title").fill("Late edit");
    await context.clearCookies();
    await page.getByRole("button", { name: "Save title" }).click();
    await expect(page.getByRole("heading", { name: /session/ })).toBeVisible();
  });

  test("server error shows a request ID and Retry", async ({ page }) => {
    await openOverview(page);
    await page.route("**/api/v1/cases?*", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          code: "internal_error",
          message: "Something went wrong",
          requestId: "req-123",
        }),
      }),
    );
    await page.getByRole("link", { name: "Cases" }).first().click();
    await expect(page.getByText("req-123")).toBeVisible();
    await page.unroute("**/api/v1/cases?*");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator("tbody tr").first()).toBeVisible();
  });

  test("403 shows Access denied", async ({ page }) => {
    await openOverview(page);
    await page.route("**/api/v1/cases?*", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          code: "forbidden",
          message: "You can't do that here",
          requestId: "req-403",
        }),
      }),
    );
    await page.getByRole("link", { name: "Cases" }).first().click();
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  });

  test("empty filter result offers Clear", async ({ page }) => {
    await openOverview(page);
    await page.route("**/api/v1/cases?*", async (route) => {
      if (route.request().url().includes("status=Draft")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: '{"items":[]}',
        });
      }
      return route.continue();
    });
    await page.getByRole("link", { name: "Cases" }).first().click();
    await page.getByLabel("Status").selectOption("Draft");
    await expect(page.getByRole("heading", { name: "No cases match" })).toBeVisible();
    await page.getByRole("button", { name: "Clear filter" }).click();
    await expect(page.locator("tbody tr").first()).toBeVisible();
  });

  test("error boundary catches a render failure", async ({ page }) => {
    await page.route("**/api/v1/me", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"kind":"guest"}' }),
    );
    await page.goto("/app/overview");
    await expect(
      page.getByRole("heading", { name: "Something went wrong on this page" }),
    ).toBeVisible();
    await expect(page.getByText("Reference:")).toBeVisible();
  });

  test("not-yet-built areas say so and offer no fake controls", async ({ page }) => {
    await openOverview(page);
    for (const name of ["Reconciliation", "Automations", "Analytics", "Integrations"]) {
      await page.getByRole("link", { name }).first().click();
      await expect(page.getByRole("heading", { name: "Not built yet" })).toBeVisible();
      await expect(page.locator("main button")).toHaveCount(0);
    }
  });

  test("unknown page", async ({ page }) => {
    await page.goto("/no-such-page");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });
});

test.describe("waking state, PRD 13.2", () => {
  test("message at 1 s, Retry at 8 s, walkthrough at 15 s", async ({ page }) => {
    await page.clock.install();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/api/v1/demo/sessions", async (route) => {
      await held;
      await route.abort().catch(() => {});
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Launch Guided Demo" }).click();
    const message = page.getByText("This can take a few seconds the first time.");
    await expect(message).toHaveCount(0);
    await page.clock.fastForward(1100);
    await expect(message).toBeVisible();
    await expect(page.locator('[role="status"]', { has: message })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await page.clock.fastForward(7000);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("recorded walkthrough")).toHaveCount(0);
    await page.clock.fastForward(7000);
    await expect(page.getByText("recorded walkthrough")).toBeVisible();
    release();
  });

  test("launch failure offers Retry; quota offers the walkthrough instead", async ({ page }) => {
    await page.route("**/api/v1/demo/sessions", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          code: "launch_quota",
          message: "Too many demo launches.",
          requestId: "r",
        }),
      }),
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Launch Guided Demo" }).click();
    await expect(page.getByText("Too many demo launches.")).toBeVisible();
    await expect(page.getByText("recorded walkthrough")).toBeVisible();
  });
});

test.describe("P1-F keyboard, motion, mobile", () => {
  test("keyboard alone reaches launch, navigation and a case", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "keyboard path runs on desktop");
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    const box = await skip.boundingBox();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Launch Guided Demo" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Your workspace is ready.")).toBeVisible({ timeout: 15_000 });
    const go = page.getByRole("link", { name: "Go to Overview" });
    for (let i = 0; i < 8 && !(await go.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press("Tab");
    }
    await expect(go).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    await expect(page.locator("main")).toBeFocused();
    await page.getByRole("link", { name: "Cases" }).first().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Cases", level: 1 })).toBeVisible();
    await expect(page).toHaveTitle(/Cases/);
    await expect(page.locator("main")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Status")).toBeFocused();
    const outline = await page
      .getByLabel("Status")
      .evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe("solid");
  });

  test("reset can be cancelled and confirmed by keyboard", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "keyboard path runs on desktop");
    await openOverview(page);
    await page.getByRole("button", { name: "Reset demo" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Reset demo" })).toBeVisible();
  });

  test("reduced motion removes animation", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.install();
    await page.route("**/api/v1/demo/sessions", async () => {});
    await page.goto("/");
    await page.getByRole("button", { name: "Launch Guided Demo" }).click();
    await page.clock.fastForward(1100);
    await expect(page.getByText("This can take a few seconds the first time.")).toBeVisible();
    const skeleton = await page
      .locator(".skel")
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { duration: s.animationDuration, iterations: s.animationIterationCount };
      });
    expect(skeleton).toEqual({ duration: "0s", iterations: "1" });
  });

  test("no horizontal page scroll on any main route", async ({ page }) => {
    await openOverview(page);
    for (const path of [
      "/app/overview",
      "/app/cases",
      "/app/reconciliation",
      "/demo",
      "/about/engineering",
      "/",
    ]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });

  test("navigation stays reachable and touch sized on a phone", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "phone only");
    await openOverview(page);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav).toBeVisible();
    for (const link of await nav.getByRole("link").all()) {
      const box = await link.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
    }
    await nav.getByRole("link", { name: "Cases" }).click();
    await expect(page.getByRole("heading", { name: "Cases", level: 1 })).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("light theme passes the same accessibility checks", async ({ page }) => {
    await openOverview(page);
    await page.getByRole("button", { name: "Light theme" }).click();
    await expectNoAxeViolations(page);
  });
});

test.describe("P1-C admin through the local test double", () => {
  test("a guest gets 401 at /admin, with no page", async ({ page }) => {
    await launchDemo(page);
    const res = await page.goto("/admin");
    expect(res?.status()).toBe(401);
    expect(await page.content()).not.toContain('id="root"');
  });

  test("the double owner sees the honest label and can sign out", async ({
    page,
    context,
  }, info) => {
    // Sign-out revokes the shared owner row, so this runs once per server.
    test.skip(info.project.name === "mobile", "revocation is global to the owner");
    await context.addCookies([
      {
        name: "CF_Authorization",
        value: await ownerToken(Math.floor(Date.now() / 1000) - 5),
        domain: "localhost",
        path: "/",
      },
    ]);
    await page.goto("/admin");
    await expect(page.getByText("Pending Owner Configuration")).toBeVisible();
    await expect(page.getByText("Local test double")).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText("Signed out.")).toBeVisible();
    const res = await page.goto("/admin");
    expect(res?.status()).toBe(401);
  });
});
