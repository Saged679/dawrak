import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createDepositTenant, enterDemo, hasLocalDb, rest, type DepositTenant } from "./helpers/tenant";

/**
 * Brand and navigation: every page type has a working path back to the landing page (/ar or /en), the logo and
 * icon assets are served with the right content types, and the 404 carries the logo. Runs on chromium and mobile.
 */

const BRAND = { ar: "دورك", en: "Dawrak" } as const;
const MAIN_SITE = { ar: "الموقع الرئيسي", en: "Main website" } as const;
const POWERED = { ar: "مدعوم بـ دورك", en: "Powered by Dawrak" } as const;
const LOCALES = ["ar", "en"] as const;

async function landsOnLanding(page: Page, locale: "ar" | "en") {
  await page.waitForURL((u) => u.pathname === `/${locale}`);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.locator("header.lp-topbar")).toBeVisible();
}

test.describe("back to the landing page from every page type", () => {
  for (const locale of LOCALES) {
    test(`login (${locale}): back link, logo link, demo button`, async ({ page }) => {
      await page.goto(`/${locale}/login`);
      const back = page.getByTestId("login-back-home");
      await expect(back).toHaveAttribute("href", `/${locale}`);
      await expect(page.getByTestId("login-try-demo")).toHaveAttribute("href", `/${locale}/demo`);
      await expect(page.locator("main p").filter({ hasText: locale === "en" ? "without an account" : "من غير حساب" })).toBeVisible();
      const logo = page.getByRole("link", { name: BRAND[locale], exact: true });
      await expect(logo).toHaveAttribute("href", `/${locale}`);
      await back.click();
      await landsOnLanding(page, locale);
      await page.goBack();
      await logo.click();
      await landsOnLanding(page, locale);
    });

    test(`demo and demo mailbox (${locale})`, async ({ page }) => {
      for (const path of ["demo", "demo/mailbox"]) {
        await page.goto(`/${locale}/${path}`);
        await expect(page.getByRole("link", { name: BRAND[locale], exact: true })).toHaveAttribute("href", `/${locale}`);
        await page.getByTestId("back-home").click();
        await landsOnLanding(page, locale);
      }
    });

    test(`dashboard (${locale}): "Main website" goes to the landing page, the logo stays in the dashboard`, async ({ page }) => {
      test.skip(!hasLocalDb(), "needs the local database");
      await enterDemo(page, "clinic-owner", locale);
      const logo = page.locator('a[href$="/dashboard"]').filter({ has: page.locator("svg") }).filter({ visible: true }).first();
      await expect(logo).toBeVisible();
      const main = page.getByRole("link", { name: MAIN_SITE[locale] }).filter({ visible: true }).first();
      await expect(main).toHaveAttribute("href", `/${locale}`);
      await main.click();
      await landsOnLanding(page, locale);
    });

    test(`dashboard user menu has the main website item (${locale})`, async ({ page }) => {
      test.skip(!hasLocalDb(), "needs the local database");
      await enterDemo(page, "clinic-owner", locale);
      await page.locator("header summary").click();
      const item = page.locator("header details").getByRole("link", { name: MAIN_SITE[locale] });
      await expect(item).toHaveAttribute("href", `/${locale}`);
      await item.click();
      await landsOnLanding(page, locale);
    });

    test(`404 (${locale}) and unknown clinic: logo and home link`, async ({ page }) => {
      for (const path of ["/no/such/page", "/c/zzz-nope-slug"]) {
        const res = await page.goto(`/${locale}${path}`);
        expect(res?.status()).toBe(404);
        await expect(page.locator("main svg").first()).toBeVisible();
        await page.locator("main a").first().click();
        await landsOnLanding(page, locale);
      }
    });

    test(`clinic page (${locale}): Powered by Dawrak`, async ({ page }) => {
      test.skip(!hasLocalDb(), "needs the local database");
      await page.goto(`/${locale}/c/demo-clinic`);
      const link = page.getByTestId("powered-by");
      await expect(link).toHaveText(POWERED[locale]);
      await expect(link).toHaveAttribute("href", `/${locale}`);
      await link.click();
      await landsOnLanding(page, locale);
    });
  }
});

test.describe("customer portal and payment pages", () => {
  test.skip(!hasLocalDb(), "needs the local database");
  let biz: DepositTenant;
  let token = "";
  let accessToken = "";
  test.beforeAll(async () => {
    biz = await createDepositTenant();
    const [customer] = (await rest("customers", {
      method: "POST",
      body: JSON.stringify({ tenant_id: biz.tenantId, full_name: "Brand Nav", phone: `0555${Math.floor(Math.random() * 1e6)}` }),
    })) as { id: string }[];
    const start = new Date(Date.now() + (70 + Math.floor(Math.random() * 20)) * 86_400_000);
    start.setUTCHours(3, 0, 0, 0);
    const [appt] = (await rest("appointments", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: biz.tenantId, provider_id: biz.providerId, service_id: biz.serviceId, customer_id: customer.id,
        starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3_600_000).toISOString(),
        status: "pending_payment", source: "web", price: biz.price,
        payment_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      }),
    })) as { id: string }[];
    token = randomBytes(36).toString("base64url");
    await rest("payments", {
      method: "POST",
      body: JSON.stringify({ tenant_id: biz.tenantId, appointment_id: appt.id, amount: 40, currency: "SAR", provider: "fake", public_token: token }),
    });
    const [{ access_token }] = (await rest(`customers?id=eq.${customer.id}&select=access_token`)) as { access_token: string }[];
    accessToken = access_token;
  });
  test.afterAll(async () => {
    await biz?.cleanup();
  });

  for (const locale of LOCALES) {
    for (const [name, path] of [
      ["my (request a link)", () => `/${locale}/c/${biz.slug}/my`],
      ["my/[token]", () => `/${locale}/c/${biz.slug}/my/${accessToken}`],
      ["pay/[token]", () => `/${locale}/c/${biz.slug}/pay/${token}`],
    ] as const) {
      test(`${name} (${locale}): Powered by Dawrak goes to the landing page`, async ({ page }) => {
        await page.goto(path());
        const link = page.getByTestId("powered-by");
        await expect(link).toHaveText(POWERED[locale]);
        await link.click();
        await landsOnLanding(page, locale);
      });
    }
  }
});

function pngSize(buf: Buffer) {
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

test.describe("icon and manifest assets", () => {
  test("/icon.svg is an SVG", async ({ request }) => {
    const res = await request.get("/icon.svg");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/svg+xml");
    expect(await res.text()).toContain("<svg");
  });

  test("/apple-icon is a 180x180 PNG with no locale redirect", async ({ request }) => {
    const res = await request.get("/apple-icon", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    expect(pngSize(await res.body())).toEqual({ w: 180, h: 180 });
  });

  for (const n of [192, 512]) {
    test(`/icon-${n}.png is a ${n}px PNG`, async ({ request }) => {
      const res = await request.get(`/icon-${n}.png`, { maxRedirects: 0 });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("image/png");
      expect(pngSize(await res.body())).toEqual({ w: n, h: n });
    });
  }

  test("/manifest.webmanifest lists the icons that exist", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/json/);
    const m = await res.json();
    expect(m.name).toContain("Dawrak");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toBe("#2549D1");
    expect(m.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of m.icons as { src: string; type: string }[]) {
      const r = await request.get(icon.src, { maxRedirects: 0 });
      expect(r.status(), icon.src).toBe(200);
      expect(r.headers()["content-type"]).toContain(icon.type);
    }
  });

  test("/favicon.ico is a valid ICO (no redirect)", async ({ request }) => {
    const res = await request.get("/favicon.ico", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/icon/);
    const b = await res.body();
    expect([...b.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect(b.subarray(22, 30).toString("hex")).toBe("89504e470d0a1a0a");
  });

  for (const locale of LOCALES) {
    test(`landing head links the icons and the OG image is a 1200x630 PNG (${locale})`, async ({ page, request }) => {
      await page.goto(`/${locale}`);
      await expect(page.locator('link[rel="icon"][href*="icon.svg"]')).toHaveCount(1);
      await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
      await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
      const og = await page.locator('meta[property="og:image"]').first().getAttribute("content");
      const res = await request.get(new URL(og!).pathname);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("image/png");
      expect(pngSize(await res.body())).toEqual({ w: 1200, h: 630 });
    });
  }

  test("JSON-LD Organization has an absolute logo URL that serves a PNG", async ({ page, request }) => {
    await page.goto("/en");
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent()) ?? "{}");
    const org = ld["@graph"].find((g: { "@type": string }) => g["@type"] === "Organization");
    expect(org.logo).toMatch(/^https?:\/\/.+\/icon-512\.png$/);
    const res = await request.get(new URL(org.logo).pathname);
    expect(res.headers()["content-type"]).toContain("image/png");
  });
});
