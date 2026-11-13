import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PayShell, StatusCard } from "@/components/payments/pay-views";
import { routing } from "@/i18n/routing";
import { derivePayState, loadPaymentView } from "@/lib/payments/store";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; slug: string; token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Payment" });
  return { title: t("resultMetaTitle"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/**
 * Where the provider sends the customer after paying. Query parameters are ignored on purpose
 * (a forged ?status=paid changes nothing): the state comes only from our database, which the
 * verified webhook updates. While it is still pending the page refreshes itself.
 */
export default async function PayResultPage({ params }: Props) {
  const { locale, slug, token } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const view = await loadPaymentView(token, slug);
  if (!view) notFound();
  const state = derivePayState(view);
  return (
    <PayShell view={view} locale={locale}>
      <StatusCard view={view} state={state} locale={locale} payHref={`/c/${slug}/pay/${token}`} />
    </PayShell>
  );
}
