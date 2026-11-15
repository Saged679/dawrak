import { expect, test } from "@playwright/test";
import { SITE } from "./helpers/site";

/** Localized 404/error pages, noindex on utility pages, and the landing hero flash. No database needed. */

const COPY = {
  ar: { title: "لم نجد هذه الصفحة", home: "العودة إلى الرئيسية", dir: "rtl" },
  en: { title: "We couldn't find this page", home: "Back to home", dir: "ltr" },
} as const;

for (const locale of ["ar", "en"] as const) {
  test.describe(`404 /${locale}`, () => {
    test("unknown path under the locale: 404, localized, lang/dir, noindex, no stack", async ({ page }) => {
      const res = await page.goto(`/${locale}/no/such/page`);
      expect(res?.status()).toBe(404);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("html")).toHaveAttribute("dir", COPY[locale].dir);
      await expect(page.locator("h1")).toHaveText(COPY[locale].title);
      await expect(page.locator("meta[name=robots]")).toHaveAttribute("content", /noindex/);
      await expect(page.getByRole("link", { name: COPY[locale].home })).toHaveAttribute("href", `/${locale}`);
      expect(await page.locator("main").innerText()).not.toMatch(/digest|at \w+ \(|node_modules|Error:/);
    });
  });
}

test.describe("404 without JavaScript: the server HTML itself carries the page", () => {
  for (const [path, locale] of [["/ar/no/such/page", "ar"], ["/en/nope", "en"], ["/en/login/extra", "en"]] as const) {
    test(`${path}`, async ({ browser }) => {
      const ctx = await browser.newContext({ javaScriptEnabled: false });
      const page = await ctx.newPage();
      const res = await page.goto(path);
      expect(res?.status()).toBe(404);
      const html = (await res!.text()).toString();
      expect(html).toContain(`<html lang="${locale}" dir="${COPY[locale].dir}"`);
      expect(html).not.toContain("__next_error__");
      await expect(page.locator("h1")).toHaveText(COPY[locale].title);
      await expect(page.getByRole("link", { name: COPY[locale].home })).toHaveAttribute("href", `/${locale}`);
      expect(html.match(/name="robots"/g)?.length).toBe(1);
      await ctx.close();
    });
  }
});

test("a bare unknown path is redirected into a locale and then 404s localized", async ({ page }) => {
  const res = await page.goto("/totally-unknown");
  expect(res?.status()).toBe(404);
  await expect(page).toHaveURL(/\/(ar|en)\/totally-unknown/);
  await expect(page.locator("html")).toHaveAttribute("lang", /ar|en/);
  await expect(page.locator("h1")).toBeVisible();
});

test("a path outside the locale tree gets the global Arabic 404 with lang and dir", async ({ page }) => {
  const res = await page.goto("/missing-file.xyz");
  expect(res?.status()).toBe(404);
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("h1")).toHaveText(COPY.ar.title);
  await expect(page.locator("meta[name=robots]")).toHaveAttribute("content", /noindex/);
});

test.describe("noindex on utility pages (not only robots.txt)", () => {
  for (const path of ["/ar/login", "/en/login", "/ar/demo", "/en/demo", "/en/demo/mailbox"]) {
    test(`${path} has robots noindex, nofollow`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("meta[name=robots]")).toHaveAttribute("content", /noindex, nofollow/);
    });
  }
  test("the landing page stays indexable", async ({ page }) => {
    await page.goto("/ar");
    await expect(page.locator("meta[name=robots]")).toHaveCount(0);
  });
});

test.describe("landing hero: no flash of the final state", () => {
  const stage = (page: import("@playwright/test").Page) => page.getByTestId("hero-demo");

  test("JS + motion: the final ticket is never visible before the animation starts", async ({ page }) => {
    await page.addInitScript(() => {
      // sample on every frame from the start: record any frame where the final ticket is visible
      (window as unknown as { __seen: string[] }).__seen = [];
      const tick = () => {
        const t = document.querySelector('[data-testid="ticket"]') as HTMLElement | null;
        const st = document.querySelector('[data-testid="hero-demo"]')?.getAttribute("data-phase");
        if (t && getComputedStyle(t).visibility !== "hidden" && st === "static")
          (window as unknown as { __seen: string[] }).__seen.push("flash");
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/en");
    await expect(stage(page)).toHaveAttribute("data-phase", /playing|done/);
    expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)).toEqual([]);
    await expect(page.getByTestId("ticket")).toBeVisible({ timeout: 20_000 });
  });

  test("reduced motion: final state immediately and it stays", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/en");
    await expect(page.getByTestId("ticket")).toBeVisible();
    await expect(page.getByTestId("cal-new")).toBeVisible();
    await expect(stage(page)).toHaveAttribute("data-phase", "static");
  });

  test("no JS: final state in the server HTML", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, reducedMotion: "no-preference" });
    const page = await ctx.newPage();
    await page.goto(`${SITE}/en`);
    await expect(page.getByTestId("ticket")).toBeVisible();
    await expect(page.getByTestId("cal-new")).toBeVisible();
    await ctx.close();
  });
});

// L3: the test-only /boom route exists only because playwright.config.ts sets ALLOW_E2E_MOCKS; it renders the
// localized error boundary and never leaks the thrown message. (Without the flag it is a 404: tests/security/boom-route.test.ts.)
test("an unexpected error shows the error page without leaking the message", async ({ page }) => {
  const res = await page.goto("/en/boom");
  expect(res?.status()).toBe(500);
  await expect(page.locator("body")).not.toContainText("SECRET-INTERNAL-DETAIL");
});
