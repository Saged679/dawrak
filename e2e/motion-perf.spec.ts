import { gzipSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { SERVICE_KEY, SUPABASE_URL, clearRateLimits, enterDemo } from "./helpers/tenant";

/**
 * Performance guard rails for the motion system: layout shift (CLS) on the three busiest surfaces, the
 * JS the landing page ships, and an INP-like measure under 4x CPU throttling. Numbers are printed as
 * `PERF {...}` lines so before/after runs can be compared.
 */
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "measured once, on desktop Chromium");
});

async function observeCls(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number; __long: number };
    w.__cls = 0;
    w.__long = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
        if (!e.hadRecentInput) w.__cls += e.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__long += e.duration;
      }).observe({ type: "longtask", buffered: true });
    } catch {
      /* longtask unsupported */
    }
  });
}
const readCls = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __cls: number; __long: number };
    return { cls: Math.round(w.__cls * 10000) / 10000, longTaskMs: Math.round(w.__long) };
  });

async function scrollThrough(page: Page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 500) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(40);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

for (const locale of ["ar", "en"]) {
  test(`CLS landing /${locale}`, async ({ page }) => {
    await observeCls(page);
    await page.goto(`/${locale}`);
    await page.waitForLoadState("networkidle");
    await scrollThrough(page);
    const r = await readCls(page);
    console.log(`PERF ${JSON.stringify({ page: `landing-${locale}`, ...r })}`);
    expect(r.cls).toBeLessThanOrEqual(0.02);
  });
}

test("CLS clinic page and booking steps", async ({ page }) => {
  await observeCls(page);
  await page.goto("/ar/c/demo-clinic");
  await page.waitForLoadState("networkidle");
  await page.locator('label:has(input[name="service-choice"])').first().click();
  await page.getByRole("button", { name: "متابعة" }).click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "متابعة" }).click();
  await page.locator('input[name="slot-choice"]').first().waitFor({ state: "attached" });
  await page.waitForTimeout(700);
  const r = await readCls(page);
  console.log(`PERF ${JSON.stringify({ page: "clinic-booking-ar", ...r })}`);
  expect(r.cls).toBeLessThanOrEqual(0.05);
});

test("CLS dashboard", async ({ page }) => {
  test.skip(!SUPABASE_URL || !SERVICE_KEY, "local Supabase env is missing");
  await clearRateLimits();
  await observeCls(page);
  await enterDemo(page, "clinic-owner", "en");
  await page.waitForLoadState("networkidle");
  await page.goto("/en/dashboard/calendar");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
  const r = await readCls(page);
  console.log(`PERF ${JSON.stringify({ page: "dashboard-calendar-en", ...r })}`);
  expect(r.cls).toBeLessThanOrEqual(0.05);
});

test("landing JavaScript transfer size", async ({ page }) => {
  let raw = 0;
  let gz = 0;
  page.on("response", async (res) => {
    if (res.request().resourceType() !== "script") return;
    try {
      const body = await res.body();
      raw += body.length;
      gz += gzipSync(body).length;
    } catch {
      /* redirected or aborted */
    }
  });
  await page.goto("/ar");
  await page.waitForLoadState("networkidle");
  const css = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => (e as PerformanceResourceTiming).initiatorType === "link" && e.name.endsWith(".css"))
      .reduce((s, e) => s + ((e as PerformanceResourceTiming).decodedBodySize || 0), 0),
  );
  console.log(`PERF ${JSON.stringify({ page: "landing-js", rawKB: +(raw / 1024).toFixed(1), gzipKB: +(gz / 1024).toFixed(1), cssRawKB: +(css / 1024).toFixed(1) })}`);
  expect(raw).toBeGreaterThan(0);
});

/** INP-like: the longest event-timing duration while clicking through under a 4x CPU slowdown. */
async function throttle(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
}
async function observeEvents(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __maxEvt: number };
    w.__maxEvt = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__maxEvt = Math.max(w.__maxEvt, e.duration);
    }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  });
}
const maxEvent = (page: Page) =>
  page.evaluate(() => Math.round((window as unknown as { __maxEvt: number }).__maxEvt));

test("INP-like under 4x CPU throttle: landing", async ({ page }) => {
  await observeEvents(page);
  await observeCls(page);
  await page.goto("/ar");
  await throttle(page);
  await page.waitForLoadState("networkidle");
  await scrollThrough(page);
  await page.locator("#faq summary").first().click();
  await page.waitForTimeout(400);
  await page.locator(".lp-nav a[href='#how']").click();
  await page.waitForTimeout(800);
  const evt = await maxEvent(page);
  const r = await readCls(page);
  console.log(`PERF ${JSON.stringify({ page: "landing-throttled", maxEventMs: evt, ...r })}`);
  expect(evt).toBeLessThan(500);
});

test("INP-like under 4x CPU throttle: booking steps", async ({ page }) => {
  await observeEvents(page);
  await page.goto("/ar/c/demo-clinic");
  await throttle(page);
  await page.waitForLoadState("networkidle");
  await page.locator('label:has(input[name="service-choice"])').first().click();
  await page.getByRole("button", { name: "متابعة" }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "متابعة" }).click();
  await page.locator('input[name="slot-choice"]').first().waitFor({ state: "attached" });
  await page.locator('label:has(input[name="slot-choice"])').first().click();
  await page.getByRole("button", { name: "متابعة" }).click();
  await page.waitForTimeout(600);
  const evt = await maxEvent(page);
  console.log(`PERF ${JSON.stringify({ page: "booking-throttled", maxEventMs: evt })}`);
  expect(evt).toBeLessThan(500);
});
