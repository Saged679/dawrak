import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import LocaleNotFound from "../not-found";

// Only reached through the proxy's rewrite for paths no route matches (src/proxy.ts), which also sets the 404
// status. Rendered as a normal page, so the HTML carries the localized content, lang and dir without JavaScript.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: hasLocale(routing.locales, locale) ? locale : routing.defaultLocale, namespace: "Errors" });
  return { title: t("notFoundTitle") }; // Next adds noindex itself for a 404 status
}

export default async function PageNotFound({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(hasLocale(routing.locales, locale) ? locale : routing.defaultLocale);
  return <LocaleNotFound />;
}
