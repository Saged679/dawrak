import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { LandingPage } from "@/components/landing/landing-page";
import { routing } from "@/i18n/routing";
import { buildLandingJsonLd, serializeJsonLd } from "@/lib/seo/jsonld";
import { buildLandingMetadata } from "@/lib/seo/metadata";
import { siteUrl } from "@/lib/seo/site";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Seo" });
  return buildLandingMetadata({ base: siteUrl(), locale, t });
}

export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const [seo, faq] = await Promise.all([
    getTranslations({ locale, namespace: "Seo" }),
    getTranslations({ locale, namespace: "Landing.faq" }),
  ]);
  // Same strings the visible FAQ renders (Landing.faq.q1..q6 / a1..a6).
  const jsonLd = buildLandingJsonLd({
    base: siteUrl(),
    locale,
    name: seo("siteName"),
    description: seo("landing.description"),
    faq: [1, 2, 3, 4, 5, 6].map((n) => ({ q: faq(`q${n}`), a: faq(`a${n}`) })),
  });
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />
      <LandingPage locale={locale} />
    </>
  );
}
