import type { MetadataRoute } from "next";
import { languageAlternates, LOCALES, localeUrl } from "./site";

export type SitemapTenant = { slug: string; is_demo: boolean };

/**
 * Demo tenants (demo-clinic, demo-salon) ARE listed: for a portfolio they are the only public
 * pages that show the product working, and they are marked as demos in title, description and
 * on the page. They carry no business JSON-LD. Flip to false to hide them from the sitemap.
 */
export const INDEX_DEMO_TENANTS = true;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Only public, indexable pages: landing + clinic pages, each in every locale with alternates. */
export function buildSitemap(base: string, tenants: SitemapTenant[]): MetadataRoute.Sitemap {
  const paths = [
    "",
    ...tenants
      .filter((t) => SLUG_RE.test(t.slug) && (INDEX_DEMO_TENANTS || !t.is_demo))
      .map((t) => `/c/${t.slug}`),
  ];
  return paths.flatMap((path) =>
    LOCALES.map((locale, i) => ({
      url: localeUrl(base, locale, path),
      alternates: { languages: languageAlternates(base, path) },
      changeFrequency: path === "" ? ("monthly" as const) : ("weekly" as const),
      priority: path === "" ? (i === 0 ? 1 : 0.9) : 0.7,
    })),
  );
}
