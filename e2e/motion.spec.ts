import { expect, test, type Page } from "@playwright/test";
import { CLINIC, SERVICE_KEY, SUPABASE_URL, clearRateLimits, enterDemo, rest } from "./helpers/tenant";

/** The calendar day (clinic time zone) of the next confirmed appointment, so a block is on screen. */
async function calendarUrlWithBlock(): Promise<string> {
  const rows = (await rest(
    `appointments?tenant_id=eq.${CLINIC}&status=eq.confirmed&starts_at=gt.${new Date(Date.now() + 36e5).toISOString()}&order=starts_at.asc&limit=1`,
  )) as { starts_at: string }[];
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date(rows[0].starts_at));
  return `/en/dashboard/calendar?view=day&date=${day}`;
}

/**
 * Motion system contract (docs/MOTION.md): reduced motion switches everything non-essential off while the
 * pages keep working, no-JS and pre-hydration visitors see all content, step slides follow the reading
 * direction, View Transitions have a CSS fallback, and nothing trips the CSP.
 */
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "motion contract runs once, on desktop Chromium");
});

const NEXT_LABEL = { ar: "متابعة", en: "Continue" } as const;

/** Running animations that never end (excluding the loading skeleton shimmer, which is functional). */
const infiniteAnimations = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.effect && (a.effect as KeyframeEffect).getComputedTiming().iterations === Infinity)
      .map((a) => (a as CSSAnimation).animationName ?? "?"),
  );

async function scrollThrough(page: Page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 600) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
    await page.waitForTimeout(30);
  }
}

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("landing: tokens collapse, nothing is hidden or counted, no looping animation", async ({ page }) => {
    await page.goto("/ar");
    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return ["--m-d1", "--m-d2", "--m-d3", "--m-d4", "--m-dist-3"].map((n) => cs.getPropertyValue(n).trim());
    });
    expect(tokens).toEqual(["1ms", "1ms", "1ms", "1ms", "0px"]);
    await scrollThrough(page);
    expect(await page.locator("[data-reveal-state]").count()).toBe(0);
    // final KPI values are in place at once (Arabic digits), not counted up
    await expect(page.locator(".lp-nums dd").first()).toHaveText("٦");
    expect(await page.locator("[data-count='pending']").count()).toBe(0);
    // the decorative glow is gone and the hero keeps its final state
    const glow = await page.evaluate(() => getComputedStyle(document.querySelector(".lp-hero")!, "::before").content);
    expect(glow).toBe("none");
    expect(await infiniteAnimations(page)).toEqual([]);
    await expect(page.getByTestId("hero-demo")).toHaveAttribute("data-phase", "static");
    // smooth scrolling is off
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  });

  test("booking: steps still advance, focus and state work, no motion runs", async ({ page }) => {
    await page.goto("/en/c/demo-clinic");
    await page.locator('label:has(input[name="service-choice"])').first().click();
    await page.getByRole("button", { name: NEXT_LABEL.en }).click();
    await expect(page.locator("form[data-step='provider']")).toBeVisible();
    const dur = await page.evaluate(() => {
      const el = document.querySelector("form[data-moved] .m-step-fwd") as HTMLElement;
      return parseFloat(getComputedStyle(el).animationDuration) * 1000;
    });
    expect(dur).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: NEXT_LABEL.en }).click();
    await page.locator('input[name="slot-choice"]').first().waitFor({ state: "attached" });
    await page.locator('label:has(input[name="slot-choice"])').first().click();
    await page.getByRole("button", { name: NEXT_LABEL.en }).click();
    await expect(page.getByLabel("Full name")).toBeVisible();
    // keyboard still works: focus a field, type
    await page.getByLabel("Full name").focus();
    await page.keyboard.type("Reduced Motion");
    await expect(page.getByLabel("Full name")).toHaveValue("Reduced Motion");
    await expect(page.getByLabel("Full name")).toBeFocused();
    expect(await infiniteAnimations(page)).toEqual([]);
  });

  test("chat: opens and closes on a phone, typing dots do not animate", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto("/en/c/demo-clinic");
    await page.getByRole("button", { name: "Open the assistant chat" }).click();
    const chat = page.getByTestId("chat-widget");
    await expect(chat).toBeVisible();
    await page.locator("#chat-input").fill("What services do you offer?");
    await page.locator("#chat-input").press("Enter");
    // the dots (if still there) have no animation; the answer arrives
    const dotAnim = await page.evaluate(() => {
      const i = document.querySelector(".m-typing > i");
      return i ? getComputedStyle(i).animationName : "none";
    });
    expect(dotAnim).toBe("none");
    await expect(chat.getByRole("log")).toContainText("What services", { timeout: 15_000 });
    await page.getByRole("button", { name: "Close the chat" }).click();
    await expect(chat).toBeHidden();
    await expect(page.getByRole("button", { name: "Open the assistant chat" })).toBeFocused();
  });

  test("dashboard: calendar dialog opens, closes with Escape and returns focus; no looping animation", async ({ page }) => {
    test.skip(!SUPABASE_URL || !SERVICE_KEY, "local Supabase env is missing");
    await enterDemo(page, "clinic-owner", "en");
    await page.goto(await calendarUrlWithBlock());
    const block = page.getByTestId("appt-block").first();
    await block.waitFor();
    await block.focus();
    await block.press("Enter");
    const dialog = page.getByTestId("appt-dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(block).toBeFocused();
    expect(await infiniteAnimations(page)).toEqual([]);
    // KPI numbers on the overview are final immediately
    await page.goto("/en/dashboard");
    const todayCount = await page.getByTestId("today-count").textContent();
    expect(todayCount).toMatch(/^\d+$/);
    expect(await page.locator("[data-count='pending']").count()).toBe(0);
  });
});

test.describe("no JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("landing: every section is visible without scripts", async ({ page }) => {
    await page.goto("/ar");
    await expect(page.locator("h1")).toBeVisible();
    const hidden = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".lp-sec .lp-head, .lp-steps li, .lp-feats > div, .lp-widget, .lp-nums dd span, .lp-faq, .lp-cta-in > *, .lp-trio > div"))
        .filter((el) => {
          const cs = getComputedStyle(el);
          return cs.opacity !== "1" || cs.visibility === "hidden";
        })
        .map((el) => el.className || el.tagName),
    );
    expect(hidden).toEqual([]);
    await expect(page.locator(".lp-nums dd").first()).toHaveText("٦");
  });

  test("clinic page: heading and booking form are visible without scripts", async ({ page }) => {
    await page.goto("/en/c/demo-clinic");
    await expect(page.locator("h1").first()).toBeVisible();
    await expect(page.getByTestId("chat-widget")).toBeAttached();
    const opacity = await page.evaluate(() => {
      const form = document.querySelector("form");
      return form ? getComputedStyle(form).opacity : "missing";
    });
    expect(opacity).toBe("1");
    await expect(page.locator('input[name="service-choice"]').first()).toBeAttached();
  });
});

test.describe("before hydration (scripts blocked, scripting still enabled)", () => {
  test("landing content is visible and count-up numbers appear by the failsafe", async ({ page }) => {
    await page.route(/\/_next\/static\/.*\.js/, (route) => route.abort());
    await page.goto("/en", { waitUntil: "domcontentloaded" });
    await expect(page.locator("h1")).toBeVisible();
    const hidden = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".lp-sec .lp-head, .lp-steps li, .lp-feats > div, .lp-widget, .lp-faq, .lp-trio > div"))
        .filter((el) => getComputedStyle(el).opacity !== "1")
        .map((el) => el.className || el.tagName),
    );
    expect(hidden).toEqual([]);
    expect(await page.locator("[data-reveal-state]").count()).toBe(0);
    // numbers wait for JS only up to 1.5 s, then the CSS failsafe shows them
    await expect
      .poll(() => page.locator(".lp-nums dd span").first().evaluate((el) => getComputedStyle(el).opacity), { timeout: 4000 })
      .toBe("1");
  });
});

test.describe("direction", () => {
  for (const [locale, sign] of [["en", 1], ["ar", -1]] as const) {
    test(`booking step slides follow reading direction (${locale})`, async ({ page }) => {
      await page.goto(`/${locale}/c/demo-clinic`);
      await page.locator('label:has(input[name="service-choice"])').first().click();
      await page.getByRole("button", { name: NEXT_LABEL[locale] }).click();
      const firstFrameX = async () =>
        page.evaluate(() => {
          const el = document.querySelector("form[data-moved] [class*='m-step-']") as HTMLElement;
          const anim = el.getAnimations()[0];
          anim.pause();
          anim.currentTime = 0;
          const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
          return { x: m.m41, name: (anim as CSSAnimation).animationName };
        });
      const fwd = await firstFrameX();
      expect(fwd.name).toBe("m-slide-fwd");
      expect(Math.sign(fwd.x)).toBe(sign); // enters from the inline-end side
      await page.getByRole("button", { name: locale === "ar" ? "رجوع" : "Back" }).click();
      const back = await firstFrameX();
      expect(back.name).toBe("m-slide-back");
      expect(Math.sign(back.x)).toBe(-sign);
    });
  }
});

test.describe("View Transitions", () => {
  test("navigation uses startViewTransition when present", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __vt: number };
      w.__vt = 0;
      const orig = document.startViewTransition?.bind(document);
      if (orig) {
        document.startViewTransition = ((...a: unknown[]) => {
          w.__vt += 1;
          return (orig as (...x: unknown[]) => ViewTransition)(...a);
        }) as typeof document.startViewTransition;
      }
    });
    await page.goto("/en");
    await page.locator(".lp-topbar").getByRole("link", { name: /demo/i }).click();
    await page.waitForURL(/\/en\/demo/);
    await expect(page.locator("h1").first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __vt: number }).__vt)).toBeGreaterThan(0);
    expect(await page.locator(".m-enter-fallback").count()).toBe(0);
  });

  test("falls back to a CSS entrance when document.startViewTransition is missing", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(document, "startViewTransition", { value: undefined, configurable: true });
    });
    await page.goto("/en");
    expect(await page.evaluate(() => typeof document.startViewTransition)).toBe("undefined");
    await page.locator(".lp-topbar").getByRole("link", { name: /demo/i }).click();
    await page.waitForURL(/\/en\/demo/);
    await expect(page.locator("h1").first()).toBeVisible();
    await expect(page.locator("[data-page-enter].m-enter-fallback")).toHaveCount(1);
    // first load is never animated
    await page.goto("/en/login");
    await expect(page.locator(".m-enter-fallback")).toHaveCount(0);
  });
});

test.describe("CSP", () => {
  test("no CSP violations or page errors on landing, clinic and dashboard", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (m) => {
      if (/content security policy|refused to (apply|load|execute|connect)/i.test(m.text())) problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        console.error(`Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    await page.goto("/ar");
    await page.waitForLoadState("networkidle");
    await scrollThrough(page);
    await page.goto("/en/c/demo-clinic");
    await page.waitForLoadState("networkidle");
    await page.locator('label:has(input[name="service-choice"])').first().click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForTimeout(500);
    if (SUPABASE_URL && SERVICE_KEY) {
      await clearRateLimits();
      await enterDemo(page, "clinic-owner", "en");
      await page.goto(await calendarUrlWithBlock());
      await page.getByTestId("appt-block").first().click();
      await expect(page.getByTestId("appt-dialog")).toBeVisible();
    }
    expect(problems).toEqual([]);
  });
});
