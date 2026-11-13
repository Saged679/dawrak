import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClinicFactsView, type ClinicFactsLabels } from "@/components/booking/clinic-facts";
import { buildClinicFacts, cleanText, type FactsTenant } from "@/lib/geo/clinic-facts";
import { buildLlmsFullTxt, buildLlmsTxt, FAQ_COUNT } from "@/lib/geo/llms";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

const SITE = "https://dawrak.example.com";
const msgs = { en, ar };

describe("llms.txt", () => {
  const txt = buildLlmsTxt(msgs, SITE + "/");

  it("has the required sections and a blockquote summary", () => {
    expect(txt.startsWith("# Dawrak")).toBe(true);
    expect(txt).toMatch(/\n> .+/);
    for (const h of ["## What Dawrak does", "## Not available yet", "## Pages", "## Questions and answers", "## Optional"]) {
      expect(txt).toContain(h);
    }
  });

  it("marks unbuilt features as planned", () => {
    expect(txt).toMatch(/Planned: connecting the assistant to WhatsApp/);
    expect(txt).toMatch(/Planned: handing a chat over/);
    expect(txt).toMatch(/Planned: reminders by SMS or WhatsApp/);
  });

  it("has no private paths or tokens", () => {
    for (const bad of [/\/dashboard/, /\/api\//, /\/my\//, /\/pay\//, /\/login/, /token/i, /service_role/i]) {
      expect(txt).not.toMatch(bad);
      expect(buildLlmsFullTxt(msgs, SITE)).not.toMatch(bad);
    }
  });

  it("builds absolute links from the site URL", () => {
    const urls = [...txt.matchAll(/\]\((.+?)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(5);
    for (const u of urls) expect(u.startsWith(SITE + "/")).toBe(true);
    expect(txt).not.toContain(SITE + "//");
    expect(txt).toContain(`${SITE}/ar/c/demo-clinic`);
  });

  it("includes the whole FAQ in English (drift: keys must exist)", () => {
    for (let i = 1; i <= FAQ_COUNT; i++) {
      expect(txt).toContain(en.Landing.faq[`q${i}` as keyof typeof en.Landing.faq]);
      expect(txt).toContain(en.Landing.faq[`a${i}` as keyof typeof en.Landing.faq]);
    }
  });

  it("fails loudly when a referenced FAQ key disappears", () => {
    const broken = structuredClone(en) as typeof en;
    delete (broken.Landing.faq as Record<string, string>).a3;
    expect(() => buildLlmsTxt({ en: broken, ar }, SITE)).toThrow(/Landing\.faq\.a3/);
  });

  it("keeps FAQ keys identical in both locales", () => {
    expect(Object.keys(ar.Landing.faq).sort()).toEqual(Object.keys(en.Landing.faq).sort());
  });
});

const tenant: FactsTenant = {
  name_ar: "عيادة الندى",
  name_en: "Al-Nada <b>clinic</b>‮\n",
  kind: "clinic",
  timezone: "Asia/Riyadh",
  currency: "SAR",
  deposit_enabled: true,
  is_demo: false,
};
const services = [
  { name_ar: "تبييض", name_en: "Whitening", description_ar: null, description_en: null, duration_min: 45, price: 850 },
];
const hours = [0, 1, 2, 3, 4].map((weekday) => ({ weekday, start: "09:00", end: "17:00" }));

describe("clinic facts", () => {
  it("formats hours and prices in English", () => {
    const f = buildClinicFacts(tenant, services, hours, "en");
    expect(f.services[0]).toMatchObject({ name: "Whitening", duration: "45 min" });
    expect(f.services[0].price.replace(/\s/g, " ")).toBe("SAR 850");
    expect(f.hours).toEqual([{ days: "Sunday to Thursday", start: "9:00 AM", end: "5:00 PM" }]);
  });

  it("formats hours and prices in Arabic", () => {
    const f = buildClinicFacts(tenant, services, hours, "ar");
    expect(f.name).toBe("عيادة الندى");
    expect(f.services[0].duration).toBe("٤٥ دقيقة");
    expect(f.services[0].price).toMatch(/٨٥٠/);
    expect(f.hours[0].days).toContain("إلى");
    expect(f.hours[0].start).toMatch(/٩:٠٠/);
  });

  it("strips control and bidi characters and caps length", () => {
    expect(cleanText("a‮b\nc\t d")).toBe("a b c d");
    expect(cleanText("x".repeat(500)).length).toBeLessThanOrEqual(120);
    expect(buildClinicFacts(tenant, services, hours, "en").name).not.toMatch(/[‮\n]/);
  });

  it("escapes markup in the rendered block", () => {
    const l = Object.fromEntries(
      Object.keys({} as ClinicFactsLabels).map((k) => [k, k]),
    ) as unknown as ClinicFactsLabels;
    const labels = new Proxy(l, {
      get: (_t, k) => (k === "hoursLine" ? (d: string, s: string, e: string) => `${d} ${s}-${e}` : String(k)),
    });
    const html = renderToStaticMarkup(
      createElement(ClinicFactsView, { facts: buildClinicFacts(tenant, services, hours, "en"), l: labels }),
    );
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("<dl");
    expect(html.replace(/\s/g, " ")).toContain("Whitening: 45 min, SAR 850");
  });
});
