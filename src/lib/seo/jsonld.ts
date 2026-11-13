import type { Locale } from "@/i18n/routing";
import type { HoursRow } from "@/lib/db/public";
import { localeUrl } from "./site";
import { tenantDisplayName, type ClinicMetaTenant } from "./metadata";

/**
 * Serializes JSON-LD for an inline <script type="application/ld+json">. `<` is escaped so a
 * tenant-controlled string such as "</script><script>..." cannot close the tag; U+2028/2029 are
 * escaped too (valid JSON, but historically line terminators in JS).
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export type FaqItem = { q: string; a: string };

/** Landing page: Organization + SoftwareApplication + FAQPage. No ratings, reviews or prices. */
export function buildLandingJsonLd(args: {
  base: string;
  locale: Locale;
  name: string;
  description: string;
  faq: FaqItem[];
}) {
  const url = localeUrl(args.base, args.locale);
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", "@id": `${args.base}/#org`, name: args.name, url: args.base },
      {
        "@type": "SoftwareApplication",
        "@id": `${url}#app`,
        name: args.name,
        url,
        description: args.description,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        inLanguage: args.locale,
        publisher: { "@id": `${args.base}/#org` },
      },
      {
        "@type": "FAQPage",
        "@id": `${url}#faq`,
        inLanguage: args.locale,
        mainEntity: args.faq.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Public clinic page. Built only from tenant fields: name(s), kind, opening hours. No address,
 * phone, geo or ratings are invented. Demo tenants are fictional, so they get no business markup
 * (returns null) to avoid presenting a made-up business as a real one.
 */
export function buildClinicJsonLd(args: {
  base: string;
  locale: Locale;
  tenant: ClinicMetaTenant;
  hours: HoursRow[];
}) {
  const { tenant, locale } = args;
  if (tenant.is_demo) return null;
  const url = localeUrl(args.base, locale, `/c/${tenant.slug}`);
  const name = tenantDisplayName(tenant, locale);
  const otherName = tenantDisplayName(tenant, locale === "ar" ? "en" : "ar");
  const specs = args.hours
    .filter((h) => Number.isInteger(h.weekday) && h.weekday >= 0 && h.weekday <= 6)
    .map((h) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: DAYS[h.weekday],
      opens: h.start,
      closes: h.end,
    }));
  return {
    "@context": "https://schema.org",
    "@type": tenant.kind === "salon" ? "BeautySalon" : "MedicalBusiness",
    "@id": `${url}#business`,
    name,
    ...(otherName && otherName !== name ? { alternateName: otherName } : {}),
    url,
    ...(specs.length ? { openingHoursSpecification: specs } : {}),
    potentialAction: {
      "@type": "ReserveAction",
      target: { "@type": "EntryPoint", urlTemplate: url, inLanguage: locale },
    },
  };
}
