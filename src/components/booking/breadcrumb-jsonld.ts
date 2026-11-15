import type { Locale } from "@/i18n/routing";
import { localeUrl } from "@/lib/seo/site";

/**
 * BreadcrumbList for a public clinic page: site home, then the business page. Structural only
 * (no business claims), so it is also emitted for demo tenants. Serialize with serializeJsonLd.
 */
export function buildClinicBreadcrumbJsonLd(args: {
  base: string;
  locale: Locale;
  slug: string;
  siteName: string;
  businessName: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: args.siteName, item: localeUrl(args.base, args.locale) },
      {
        "@type": "ListItem",
        position: 2,
        name: args.businessName,
        item: localeUrl(args.base, args.locale, `/c/${args.slug}`),
      },
    ],
  };
}
