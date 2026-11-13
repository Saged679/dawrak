import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { getTenantBySlug } from "@/lib/db/public";
import { tenantDisplayName } from "@/lib/seo/metadata";
import { OG_SIZE, renderOgImage } from "@/lib/seo/og";

export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "Dawrak";

export default async function Image({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale: raw, slug } = await params;
  const locale = hasLocale(routing.locales, raw) ? raw : routing.defaultLocale;
  const [t, tc] = await Promise.all([
    getTranslations({ locale, namespace: "Seo" }),
    getTranslations({ locale, namespace: "Clinic" }),
  ]);
  // Unknown slug or a database error: fall back to the generic brand card, never fail the image.
  const tenant = await getTenantBySlug(slug).catch(() => null);
  if (!tenant) {
    return renderOgImage({
      locale,
      brand: t("siteName"),
      title: t("landing.ogHeadline"),
      subtitle: t("landing.ogSub"),
    });
  }
  return renderOgImage({
    locale,
    brand: t("siteName"),
    title: tenantDisplayName(tenant, locale),
    subtitle: `${tc(`kind.${tenant.kind}`)} · ${t("clinic.ogCta")}`,
    badge: tenant.is_demo ? t("clinic.ogDemo") : undefined,
  });
}
