import { expect, test, type Page } from "@playwright/test";

/** Marketing home page. Needs no database, except the CTA link checks that open /demo and the clinic page. */

const LOCALES = ["ar", "en"] as const;

function collectViolations(page: Page) {
  const found: string[] = [];
  page.on("console", (m) => {
    if (/content security policy|violates the following/i.test(m.text())) found.push(m.text());
  });
  page.on("pageerror", (e) => found.push(e.message));
  return found;
}

for (const locale of LOCALES) {
  test.describe(`landing /${locale}`, () => {
    test("renders with one h1, landmarks and the final booking", async ({ page }) => {
      const violations = collectViolations(page);
      await page.goto(`/${locale}`);
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("contentinfo")).toBeVisible();
      await expect(page.locator("main h2").first()).toBeVisible();
      await expect(page.locator("details")).toHaveCount(6);
      await page.waitForLoadState("networkidle");
      // the scripted chat ends with the confirmation ticket and the calendar booking
      await expect(page.getByTestId("ticket")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("cal-new")).toBeVisible();
      expect(violations).toEqual([]);
    });

    test("CTA links resolve to working pages", async ({ page, request }) => {
      await page.goto(`/${locale}`);
      const hrefs = await page.locator("main a[href^='/']").evaluateAll((els) =>
        els.map((e) => (e as HTMLAnchorElement).getAttribute("href")),
      );
      expect(hrefs).toContain(`/${locale}/demo`);
      expect(hrefs).toContain(`/${locale}/c/demo-clinic`);
      for (const href of [`/${locale}/demo`, `/${locale}/c/demo-clinic`, `/${locale}/login`]) {
        const res = await request.get(href);
        expect(res.status(), href).toBe(200);
      }
    });

    test("the primary CTA opens the demo page", async ({ page }) => {
      await page.goto(`/${locale}`);
      await page.locator("main").getByRole("link", { name: locale === "ar" ? "جرّب الديمو" : "Try the demo" }).first().click();
      await page.waitForURL(`**/${locale}/demo`);
    });

    test("no page-level horizontal overflow at 360 and 1280", async ({ page }) => {
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/${locale}`);
        await page.waitForLoadState("networkidle");
        const over = await page.evaluate(() => ({
          doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          body: document.body.scrollWidth - document.documentElement.clientWidth,
        }));
        expect(over.doc, `html at ${width}`).toBeLessThanOrEqual(0);
        expect(over.body, `body at ${width}`).toBeLessThanOrEqual(0);
      }
    });

    test("locale switcher keeps the path", async ({ page }) => {
      await page.goto(`/${locale}`);
      const other = locale === "ar" ? "en" : "ar";
      await page.locator("header").locator(`a[hreflang="${other}"]`).click();
      await page.waitForURL(new RegExp(`/${other}/?$`));
      await expect(page.locator("html")).toHaveAttribute("lang", other);
    });
  });
}

test("replay restarts the conversation and reaches the final state again", async ({ page }) => {
  await page.goto("/en");
  const replay = page.getByTestId("hero-replay");
  await expect(replay).toBeVisible({ timeout: 20_000 });
  await replay.focus();
  await page.keyboard.press("Enter"); // keyboard operable
  await expect(page.getByTestId("hero-demo")).toHaveAttribute("data-phase", "playing");
  await expect(page.getByTestId("ticket")).toHaveCount(0);
  await expect(page.getByTestId("cal-new")).toHaveCSS("opacity", "0");
  await expect(page.getByTestId("ticket")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("hero-demo")).toHaveAttribute("data-phase", "done", { timeout: 5_000 });
  await expect(page.getByTestId("cal-new")).toHaveCSS("opacity", "1");
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("shows the final state at once, without a replay button", async ({ page }) => {
    await page.goto("/ar");
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("hero-demo")).toHaveAttribute("data-phase", "static");
    await expect(page.getByTestId("ticket")).toBeVisible();
    await expect(page.getByTestId("cal-new")).toBeVisible();
    await expect(page.getByTestId("hero-replay")).toBeHidden();
  });
});

test.describe("no JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  for (const locale of LOCALES) {
    test(`/${locale} shows the final state and the FAQ`, async ({ page }) => {
      await page.goto(`/${locale}`);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.getByTestId("ticket")).toBeVisible();
      await expect(page.getByTestId("cal-new")).toBeVisible();
      await expect(page.locator("details")).toHaveCount(6);
    });
  }
});

test.describe("sample dates", () => {
  test.use({ reducedMotion: "reduce" });
  test("Hijri and Gregorian dates both appear", async ({ page }) => {
  await page.goto("/ar");
  await expect(page.getByTestId("ticket")).toContainText("١٤٤٨");
  await expect(page.getByTestId("ticket")).toContainText("٢٠٢٦");
  await page.goto("/en");
  await expect(page.getByTestId("ticket")).toContainText("1448");
  await expect(page.getByTestId("ticket")).toContainText("2026");
});
});
