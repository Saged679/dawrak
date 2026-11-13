import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { buildClinicJsonLd, buildLandingJsonLd, serializeJsonLd } from "@/lib/seo/jsonld";
import {
  buildClinicMetadata,
  buildLandingMetadata,
  DESCRIPTION_MAX,
  fitTitle,
  TITLE_MAX,
} from "@/lib/seo/metadata";
import { AI_CRAWLERS, buildRobots, disallowedPaths } from "@/lib/seo/robots";
import { siteUrl } from "@/lib/seo/site";
import { buildSitemap } from "@/lib/seo/sitemap";

const BASE = "https://dawrak.example";
const MSG = { ar: ar.Seo, en: en.Seo } as const;

/** Minimal next-intl-like translator over the real Seo messages (supports {name}). */
function tr(locale: "ar" | "en") {
  return (key: string, values?: Record<string, string>) => {
    const v = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], MSG[locale]);
    return String(v).replace(/\{(\w+)\}/g, (_, k: string) => values?.[k] ?? "");
  };
}
const len = (s: unknown) => [...String(s)].length;

type T = Parameters<typeof buildClinicMetadata>[0]["tenant"];
const tenant = (over: Partial<T> = {}): T => ({
  slug: "nabd",
  name_ar: "عيادة نبض لطب الأسنان",
  name_en: "Nabd Dental Clinic",
  kind: "clinic",
  is_demo: false,
  ...over,
});

describe("metadata builders", () => {
  for (const locale of ["ar", "en"] as const) {
    it(`landing ${locale}: limits, canonical, hreflang, og/twitter`, () => {
      const m = buildLandingMetadata({ base: BASE, locale, t: tr(locale) });
      expect(len(m.title)).toBeLessThanOrEqual(TITLE_MAX);
      expect(len(m.description)).toBeLessThanOrEqual(DESCRIPTION_MAX);
      expect(m.alternates?.canonical).toBe(`${BASE}/${locale}`);
      expect(m.alternates?.languages).toEqual({
        ar: `${BASE}/ar`,
        en: `${BASE}/en`,
        "x-default": `${BASE}/ar`,
      });
      expect(m.openGraph).toMatchObject({ locale: locale === "ar" ? "ar_AR" : "en_US", url: `${BASE}/${locale}` });
      expect(m.twitter).toMatchObject({ card: "summary_large_image" });
    });

    for (const kind of ["clinic", "salon"] as const) {
      for (const is_demo of [false, true]) {
        it(`clinic page ${locale} ${kind} demo=${is_demo}: limits and canonical`, () => {
          const m = buildClinicMetadata({ base: BASE, locale, tenant: tenant({ kind, is_demo }), t: tr(locale) });
          expect(len(m.title)).toBeLessThanOrEqual(TITLE_MAX);
          expect(len(m.description)).toBeLessThanOrEqual(DESCRIPTION_MAX);
          expect(m.alternates?.canonical).toBe(`${BASE}/${locale}/c/nabd`);
          expect(String(m.title)).toContain(locale === "en" ? "Nabd" : "نبض");
        });
      }
    }
  }

  it("falls back to the Arabic name when there is no English name, and shortens long names", () => {
    const m = buildClinicMetadata({ base: BASE, locale: "en", tenant: tenant({ name_en: null }), t: tr("en") });
    expect(String(m.title)).toContain("عيادة نبض");
    const long = "x".repeat(200);
    const m2 = buildClinicMetadata({ base: BASE, locale: "en", tenant: tenant({ name_en: long }), t: tr("en") });
    expect(len(m2.title)).toBeLessThanOrEqual(TITLE_MAX);
    expect(String(m2.title)).toContain("Book a clinic appointment");
    expect(len(fitTitle("short", (n) => `${n} | z`))).toBe(9);
  });

  it("siteUrl normalises and falls back", () => {
    expect(siteUrl("https://a.example/")).toBe("https://a.example");
    expect(siteUrl("not a url")).toBe("http://localhost:3000");
    expect(siteUrl("")).toBe("http://localhost:3000");
  });
});

describe("sitemap", () => {
  const entries = buildSitemap(BASE, [
    { slug: "demo-clinic", is_demo: true },
    { slug: "real-clinic", is_demo: false },
    { slug: "Bad Slug/../x", is_demo: false },
  ]);
  const urls = entries.map((e) => e.url);

  it("lists landing and clinic pages in both locales with alternates", () => {
    expect(urls).toEqual(
      expect.arrayContaining([
        `${BASE}/ar`,
        `${BASE}/en`,
        `${BASE}/ar/c/real-clinic`,
        `${BASE}/en/c/real-clinic`,
        `${BASE}/ar/c/demo-clinic`,
      ]),
    );
    for (const e of entries) {
      expect(Object.keys(e.alternates?.languages ?? {}).sort()).toEqual(["ar", "en", "x-default"]);
    }
  });

  it("never lists private or invalid paths", () => {
    for (const u of urls) {
      expect(u).not.toMatch(/\/(my|pay|dashboard|login|api|mailbox)(\/|$)/);
      expect(u).not.toContain("Bad");
    }
    expect(urls).toHaveLength(6);
  });
});

describe("robots", () => {
  const r = buildRobots(BASE);
  it("points at the sitemap and disallows private areas", () => {
    expect(r.sitemap).toBe(`${BASE}/sitemap.xml`);
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule.allow).toBe("/");
    const d = rule.disallow as string[];
    expect(d).toEqual(
      expect.arrayContaining([
        "/api/",
        "/ar/dashboard",
        "/en/login",
        "/ar/demo/mailbox",
        "/*/c/*/pay",
        "/*/c/*/my",
      ]),
    );
    expect(d).toEqual(disallowedPaths());
    expect(d).not.toContain("/");
  });

  it("names the AI search crawlers, each repeating the * group disallow lines", () => {
    const rules = r.rules as { userAgent: string; allow: string; disallow: string[] }[];
    expect(rules[0].userAgent).toBe("*");
    expect(AI_CRAWLERS).toEqual(["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]);
    for (const bot of AI_CRAWLERS) {
      const rule = rules.find((x) => x.userAgent === bot);
      expect(rule, bot).toBeDefined();
      expect(rule?.allow).toBe("/");
      expect(rule?.disallow).toEqual(rules[0].disallow);
    }
    expect(rules).toHaveLength(1 + AI_CRAWLERS.length);
  });

  it("sitemap line follows NEXT_PUBLIC_SITE_URL", () => {
    expect(buildRobots(siteUrl("https://dawrak.app/")).sitemap).toBe("https://dawrak.app/sitemap.xml");
  });
});

describe("JSON-LD", () => {
  it("escapes < so a hostile tenant name cannot close the script tag", () => {
    const evil = "</script><script>alert(1)</script><img src=x onerror=alert(2)>";
    const ld = buildClinicJsonLd({
      base: BASE,
      locale: "en",
      tenant: tenant({ name_en: evil, name_ar: evil }),
      hours: [],
    });
    const out = serializeJsonLd(ld);
    expect(out).not.toContain("<");
    expect(out.toLowerCase()).not.toContain("</script");
    expect(JSON.parse(out).name).toBe(evil); // still round-trips as data
    const seps = String.fromCharCode(0x2028, 0x2029);
    const sepOut = serializeJsonLd({ a: seps });
    expect(sepOut).not.toContain(String.fromCharCode(0x2028));
    expect(sepOut).not.toContain(String.fromCharCode(0x2029));
  });

  it("clinic JSON-LD uses only tenant fields", () => {
    const ld = buildClinicJsonLd({
      base: BASE,
      locale: "ar",
      tenant: tenant(),
      hours: [
        { weekday: 0, start: "09:00", end: "17:00" },
        { weekday: 9, start: "09:00", end: "17:00" },
      ],
    });
    expect(ld).toMatchObject({
      "@type": "MedicalBusiness",
      name: "عيادة نبض لطب الأسنان",
      alternateName: "Nabd Dental Clinic",
    });
    expect(ld?.openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Sunday", opens: "09:00", closes: "17:00" },
    ]);
    const keys = Object.keys(ld!);
    for (const banned of ["address", "telephone", "geo", "aggregateRating", "review", "priceRange"]) {
      expect(keys).not.toContain(banned);
    }
    expect(buildClinicJsonLd({ base: BASE, locale: "ar", tenant: tenant({ kind: "salon" }), hours: [] })).toMatchObject({
      "@type": "BeautySalon",
    });
  });

  it("emits no business markup for fictional demo tenants", () => {
    expect(buildClinicJsonLd({ base: BASE, locale: "ar", tenant: tenant({ is_demo: true }), hours: [] })).toBeNull();
  });

  for (const locale of ["ar", "en"] as const) {
    it(`landing FAQ text equals the visible FAQ (${locale})`, () => {
      const faq = (locale === "ar" ? ar : en).Landing.faq as Record<string, string>;
      const ld = buildLandingJsonLd({
        base: BASE,
        locale,
        name: MSG[locale].siteName,
        description: MSG[locale].landing.description,
        faq: [1, 2, 3, 4, 5, 6].map((n) => ({ q: faq[`q${n}`], a: faq[`a${n}`] })),
      });
      const page = ld["@graph"].find((g) => g["@type"] === "FAQPage") as unknown as {
        mainEntity: { name: string; acceptedAnswer: { text: string } }[];
      };
      expect(page.mainEntity).toHaveLength(6);
      page.mainEntity.forEach((q, i) => {
        expect(q.name).toBe(faq[`q${i + 1}`]);
        expect(q.acceptedAnswer.text).toBe(faq[`a${i + 1}`]);
      });
      expect(JSON.stringify(ld)).not.toMatch(/aggregateRating|"review"|"offers"|"price"/);
    });
  }
});

describe("message copy fits the limits without clipping", () => {
  for (const [locale, m] of [["ar", ar], ["en", en]] as const) {
    it(`Seo strings in ${locale}`, () => {
      expect(len(m.Seo.landing.title)).toBeLessThanOrEqual(TITLE_MAX);
      expect(len(m.Seo.landing.description)).toBeLessThanOrEqual(DESCRIPTION_MAX);
      for (const [k, v] of Object.entries(m.Seo.clinic)) {
        // with a 30 character tenant name
        const filled = v.replace("{name}", "x".repeat(30));
        if (k.startsWith("title")) expect(len(filled)).toBeLessThanOrEqual(TITLE_MAX);
        if (k.startsWith("desc")) expect(len(filled)).toBeLessThanOrEqual(DESCRIPTION_MAX);
      }
    });
  }
});
