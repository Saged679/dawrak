import { routing, type Locale } from "@/i18n/routing";

/** Public origin without a trailing slash. NEXT_PUBLIC_SITE_URL, falling back to local dev. */
export function siteUrl(raw: string | undefined = process.env.NEXT_PUBLIC_SITE_URL): string {
  const fallback = "http://localhost:3000";
  const value = (raw ?? "").trim();
  if (!value) return fallback;
  try {
    return new URL(value).origin;
  } catch {
    return fallback;
  }
}

export const LOCALES = routing.locales;
export const DEFAULT_LOCALE = routing.defaultLocale;

/** Absolute URL of a path ("" or "/c/x") in a locale. The landing page is /ar and /en. */
export function localeUrl(base: string, locale: Locale, path = ""): string {
  return `${base}/${locale}${path === "/" ? "" : path}`;
}

/** hreflang map for one page: every locale plus x-default pointing at the default locale. */
export function languageAlternates(base: string, path = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of LOCALES) out[l] = localeUrl(base, l, path);
  out["x-default"] = localeUrl(base, DEFAULT_LOCALE, path);
  return out;
}

export const OG_LOCALE: Record<Locale, string> = { ar: "ar_AR", en: "en_US" };
