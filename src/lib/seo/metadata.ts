import type { Metadata } from "next";
import type { Locale } from "@/i18n/routing";
import { languageAlternates, localeUrl, OG_LOCALE } from "./site";

/** Private or utility pages: kept out of the index even when a crawler is allowed to fetch them. */
export const NOINDEX: Metadata = { robots: { index: false, follow: false } };

export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 155;

/** Cuts a string to `max` characters (code points), ending with an ellipsis when shortened. */
export function clip(text: string, max: number): string {
  const chars = [...text.trim().replace(/\s+/g, " ")];
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** Shortens only the tenant name until the whole title fits, so the fixed wording is never cut. */
export function fitTitle(name: string, build: (name: string) => string, max = TITLE_MAX): string {
  const clean = name.trim().replace(/\s+/g, " ");
  const title = build(clean);
  const over = [...title].length - max;
  if (over <= 0) return title;
  const chars = [...clean];
  const keep = Math.max(1, chars.length - over - 1); // one more for the ellipsis
  return clip(build(`${chars.slice(0, keep).join("").trimEnd()}…`), max);
}

type PageInput = {
  base: string;
  locale: Locale;
  /** "" for the landing page, "/c/<slug>" for a clinic page. */
  path: string;
  title: string;
  description: string;
  siteName: string;
  /** Open Graph type. */
  type?: "website";
};

/** Shared builder: title, description, canonical, hreflang, Open Graph and Twitter card. */
export function buildPageMetadata(i: PageInput): Metadata {
  const title = clip(i.title, TITLE_MAX);
  const description = clip(i.description, DESCRIPTION_MAX);
  const url = localeUrl(i.base, i.locale, i.path);
  const other = i.locale === "ar" ? "en" : "ar";
  return {
    title,
    description,
    alternates: { canonical: url, languages: languageAlternates(i.base, i.path) },
    openGraph: {
      type: i.type ?? "website",
      url,
      siteName: i.siteName,
      title,
      description,
      locale: OG_LOCALE[i.locale],
      alternateLocale: [OG_LOCALE[other]],
    },
    twitter: { card: "summary_large_image", title, description },
  };
}

type Tr = (key: string, values?: Record<string, string>) => string;

export function buildLandingMetadata(args: { base: string; locale: Locale; t: Tr }): Metadata {
  return buildPageMetadata({
    base: args.base,
    locale: args.locale,
    path: "",
    title: args.t("landing.title"),
    description: args.t("landing.description"),
    siteName: args.t("siteName"),
  });
}

export type ClinicMetaTenant = {
  slug: string;
  name_ar: string;
  name_en: string | null;
  kind: "clinic" | "salon";
  is_demo: boolean;
};

/** Tenant name in the page locale; falls back to the Arabic name when no English name exists. */
export function tenantDisplayName(t: Pick<ClinicMetaTenant, "name_ar" | "name_en">, locale: Locale): string {
  const en = t.name_en?.trim();
  return locale === "en" ? en || t.name_ar : t.name_ar;
}

export function buildClinicMetadata(args: {
  base: string;
  locale: Locale;
  tenant: ClinicMetaTenant;
  t: Tr;
}): Metadata {
  const { tenant, t, locale } = args;
  const name = tenantDisplayName(tenant, locale);
  const key = tenant.kind === "salon" ? "Salon" : "Clinic";
  const demo = tenant.is_demo ? "Demo" : "";
  const title = fitTitle(name, (n) => t(`clinic.title${demo}${key}`, { name: n }));
  const description = t(`clinic.desc${demo}${key}`, { name });
  const meta = buildPageMetadata({
    base: args.base,
    locale,
    path: `/c/${tenant.slug}`,
    title,
    description,
    siteName: t("siteName"),
  });
  return meta;
}
