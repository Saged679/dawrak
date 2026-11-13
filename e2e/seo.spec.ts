import { expect, test } from "@playwright/test";

/**
 * SEO checks. The first describe blocks need no database (the sitemap degrades to the landing
 * pages when the tenant query fails). The last block is tagged @db: it needs the local Supabase
 * stack with seed data, and is meant to be run by the QA agent once the stack is up.
 */
const SITE = "http://localhost:3000"; // NEXT_PUBLIC_SITE_URL in playwright.config.ts

for (const locale of ["ar", "en"] as const) {
  test.describe(`landing head /${locale}`, () => {
    test("title, description, canonical, hreflang, og, twitter", async ({ page }) => {
      await page.goto(`/${locale}`);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
      const title = await page.title();
      expect(title.length).toBeGreaterThan(10);
      expect([...title].length).toBeLessThanOrEqual(60);
      const desc = await page.locator('meta[name="description"]').getAttribute("content");
      expect([...(desc ?? "")].length).toBeLessThanOrEqual(155);
      expect([...(desc ?? "")].length).toBeGreaterThan(50);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${SITE}/${locale}`);
      for (const [lang, href] of [
        ["ar", `${SITE}/ar`],
        ["en", `${SITE}/en`],
        ["x-default", `${SITE}/ar`],
      ]) {
        await expect(page.locator(`link[rel="alternate"][hreflang="${lang}"]`)).toHaveAttribute("href", href);
      }
      await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute(
        "content",
        locale === "ar" ? "ar_AR" : "en_US",
      );
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", `${SITE}/${locale}`);
      await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
      await expect(page.locator('meta[name="robots"]')).toHaveCount(0); // indexable
    });

    test("one h1, h2 sections, language switcher carries hreflang", async ({ page }) => {
      await page.goto(`/${locale}`);
      await expect(page.locator("h1")).toHaveCount(1);
      expect(await page.locator("main h2").count()).toBeGreaterThan(3);
      const other = locale === "ar" ? "en" : "ar";
      await expect(page.locator(`a[hreflang="${other}"]`).first()).toHaveAttribute("href", `/${other}`);
    });

    test("JSON-LD: FAQPage matches the visible FAQ, no ratings or prices", async ({ page }) => {
      await page.goto(`/${locale}`);
      const raw = await page.locator('script[type="application/ld+json"]').first().textContent();
      const ld = JSON.parse(raw ?? "{}");
      const types = ld["@graph"].map((g: { "@type": string }) => g["@type"]);
      expect(types).toEqual(expect.arrayContaining(["Organization", "SoftwareApplication", "FAQPage"]));
      const faq = ld["@graph"].find((g: { "@type": string }) => g["@type"] === "FAQPage");
      expect(faq.mainEntity).toHaveLength(6);
      const summaries = await page.locator("#faq summary").allTextContents();
      const answers = await page.locator("#faq details > p").allTextContents();
      expect(faq.mainEntity.map((q: { name: string }) => q.name)).toEqual(summaries.map((s) => s.trim()));
      expect(faq.mainEntity.map((q: { acceptedAnswer: { text: string } }) => q.acceptedAnswer.text)).toEqual(
        answers.map((s) => s.trim()),
      );
      expect(raw).not.toMatch(/aggregateRating|"review"|"offers"|"price"/);
    });

    test("og image renders as a PNG", async ({ request }) => {
      const res = await request.get(`/${locale}/opengraph-image`);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("image/png");
    });
  });
}

test.describe("robots and redirects", () => {
  test("robots.txt allows public pages, blocks private areas, names the sitemap", async ({ request }) => {
    const res = await request.get("/robots.txt");
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain("Allow: /");
    for (const p of ["/api/", "/ar/dashboard", "/en/login", "/en/demo/mailbox", "/*/c/*/pay", "/*/c/*/my"]) {
      expect(body).toContain(`Disallow: ${p}`);
    }
    expect(body).toContain(`Sitemap: ${SITE}/sitemap.xml`);
    for (const bot of ["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]) {
      const group = body.split(/\r?\n\r?\n/).find((g) => g.includes(`User-Agent: ${bot}`));
      expect(group, bot).toBeDefined();
      expect(group).toContain("Allow: /");
      expect(group).toContain("Disallow: /ar/dashboard");
      expect(group).toContain("Disallow: /*/c/*/my");
    }
  });

  test("sitemap lists both landing locales with alternates and nothing private", async ({ request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`<loc>${SITE}/ar</loc>`);
    expect(xml).toContain(`<loc>${SITE}/en</loc>`);
    expect(xml).toContain('hreflang="x-default"');
    expect(xml).not.toMatch(/\/(my|pay|dashboard|login|api|mailbox)(\/|<)/);
  });

  test("/ makes one redirect hop to a locale page (no chain)", async ({ request }) => {
    const first = await request.get("/", { maxRedirects: 0 });
    expect([307, 308]).toContain(first.status());
    const target = first.headers()["location"];
    expect(target).toMatch(/^(\/|http:\/\/localhost:3000\/)(ar|en)$/);
    const second = await request.get(target, { maxRedirects: 0 });
    expect(second.status()).toBe(200);
  });

  test("/ar and /en answer 200 directly", async ({ request }) => {
    for (const l of ["ar", "en"]) {
      expect((await request.get(`/${l}`, { maxRedirects: 0 })).status()).toBe(200);
    }
  });

  test("unknown pages return 404 with noindex", async ({ request }) => {
    const res = await request.get("/ar/definitely-not-a-page");
    expect(res.status()).toBe(404);
    expect(await res.text()).toContain('<meta name="robots" content="noindex"');
  });
});

// ---- Needs the local Supabase stack with seed data (demo-clinic, demo-salon). QA agent: run with the stack up. ----
test.describe("clinic pages @db", () => {
  test("demo clinic head: title, canonical, hreflang, og image, no business JSON-LD", async ({ page }) => {
    await page.goto("/ar/c/demo-clinic");
    expect(await page.title()).toContain("تجريبية");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${SITE}/ar/c/demo-clinic`);
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute(
      "href",
      `${SITE}/en/c/demo-clinic`,
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /opengraph-image/);
    // demo tenants are fictional: no LocalBusiness-style markup
    await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
  });

  test("sitemap includes the demo clinic and salon in both locales", async ({ request }) => {
    const xml = await (await request.get("/sitemap.xml")).text();
    for (const slug of ["demo-clinic", "demo-salon"]) {
      expect(xml).toContain(`<loc>${SITE}/ar/c/${slug}</loc>`);
      expect(xml).toContain(`<loc>${SITE}/en/c/${slug}</loc>`);
    }
  });

  test("unknown clinic slug is a 404 with noindex", async ({ request }) => {
    const res = await request.get("/ar/c/no-such-clinic");
    expect(res.status()).toBe(404);
    expect(await res.text()).toContain('<meta name="robots" content="noindex"');
  });

  // TODO(QA): needs a non-demo tenant seeded. Expect MedicalBusiness/BeautySalon JSON-LD with
  // openingHoursSpecification, no address/telephone/aggregateRating, and no "<" inside the script text.
  test.fixme("real tenant page carries business JSON-LD", async () => {});
});
