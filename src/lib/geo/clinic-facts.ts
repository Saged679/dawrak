import {
  formatClock,
  formatMoney,
  formatNumber,
  groupHours,
  weekdayLong,
  type Loc,
} from "@/components/booking/dates";

/** Subset of PublicTenant / PublicService the facts need (structural, no server-only import). */
export type FactsTenant = {
  name_ar: string;
  name_en: string | null;
  kind: "clinic" | "salon";
  timezone: string;
  currency: string;
  deposit_enabled: boolean;
  is_demo: boolean;
};
export type FactsService = {
  name_ar: string;
  name_en: string | null;
  description_ar: string | null;
  description_en: string | null;
  duration_min: number;
  price: number;
};
export type FactsHours = { weekday: number; start: string; end: string };

export type ClinicFactsData = {
  name: string;
  kind: "clinic" | "salon";
  timezone: string;
  depositEnabled: boolean;
  isDemo: boolean;
  services: { name: string; description: string | null; duration: string; price: string }[];
  hours: { days: string; start: string; end: string }[];
};

const PHRASES = {
  ar: { min: (n: string) => `${n} دقيقة`, range: (a: string, b: string) => `${a} إلى ${b}` },
  en: { min: (n: string) => `${n} min`, range: (a: string, b: string) => `${a} to ${b}` },
} as const;

// React escapes tenant text on render. This also drops control and bidi-override characters,
// collapses whitespace and caps the length so a name cannot reshape the block.
const BAD = /[\p{Cc}‪-‮⁦-⁩‎‏؜]/gu;
export function cleanText(raw: string | null | undefined, max = 120): string {
  const s = (raw ?? "").replace(BAD, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s;
}

export function buildClinicFacts(
  tenant: FactsTenant,
  services: FactsService[],
  hours: FactsHours[],
  locale: Loc,
): ClinicFactsData {
  const ph = PHRASES[locale];
  const pickName = (ar: string, en: string | null) =>
    cleanText(locale === "en" ? en || ar : ar) || cleanText(ar);
  return {
    name: pickName(tenant.name_ar, tenant.name_en),
    kind: tenant.kind,
    timezone: cleanText(tenant.timezone, 60),
    depositEnabled: tenant.deposit_enabled,
    isDemo: tenant.is_demo,
    services: services.map((s) => ({
      name: pickName(s.name_ar, s.name_en),
      description:
        cleanText(locale === "en" ? s.description_en || s.description_ar : s.description_ar, 300) || null,
      duration: ph.min(formatNumber(s.duration_min, locale)),
      price: formatMoney(s.price, tenant.currency, locale),
    })),
    hours: groupHours(hours).map((g) => ({
      days:
        g.from === g.to
          ? weekdayLong(g.from, locale)
          : ph.range(weekdayLong(g.from, locale), weekdayLong(g.to, locale)),
      start: formatClock(g.start, locale),
      end: formatClock(g.end, locale),
    })),
  };
}
