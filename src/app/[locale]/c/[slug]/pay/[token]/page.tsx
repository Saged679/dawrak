import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BookingSummary, PayShell, StatusCard } from "@/components/payments/pay-views";
import { HoldCountdown } from "@/components/payments/hold-countdown";
import { routing } from "@/i18n/routing";
import { derivePayState, loadPaymentView } from "@/lib/payments/store";
import { startPayment } from "../actions";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; slug: string; token: string }>;
  searchParams: Promise<{ error?: string }>;
};

// The URL carries the secret token: never index it and never send it in a Referer header.
export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Payment" });
  return { title: t("metaTitle"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

export default async function PayPage({ params, searchParams }: Props) {
  const { locale, slug, token } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const view = await loadPaymentView(token, slug);
  if (!view) notFound();

  const now = new Date();
  const state = derivePayState(view, now);
  const t = await getTranslations("Payment");
  const { error } = await searchParams;
  const payHref = `/c/${slug}/pay/${token}`;

  if (state === "paid" || state === "expired" || state === "refund_due") {
    return (
      <PayShell view={view} locale={locale}>
        <StatusCard view={view} state={state} locale={locale} payHref={payHref} />
      </PayShell>
    );
  }

  const expiresAt = view.appointment.paymentExpiresAt
    ? new Date(view.appointment.paymentExpiresAt).getTime()
    : now.getTime();
  const errorText = error === "rate" ? t("errorRate") : error === "start" ? t("errorStart") : null;

  return (
    <PayShell view={view} locale={locale}>
      <section aria-labelledby="pay-title" className="rounded-2xl border border-line bg-paper p-4 shadow-sm sm:p-6">
        <h1 id="pay-title" className="font-heading text-xl font-semibold text-ink">
          {t("title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("lead")}</p>

        {state === "failed" ? (
          <div role="alert" data-testid="pay-failed" className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <p className="font-medium">{t("retryTitle")}</p>
            <p className="mt-1">{t("retryLead")}</p>
          </div>
        ) : null}
        {errorText ? (
          <p role="alert" className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
            {errorText}
          </p>
        ) : null}

        <div className="mt-4 flex flex-col gap-4">
          <BookingSummary view={view} locale={locale} />
          <HoldCountdown expiresAtMs={expiresAt} serverNowMs={now.getTime()} />
          <form action={startPayment} className="flex flex-col gap-2">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="locale" value={locale} />
            <Button type="submit" size="lg" className="h-11 w-full text-base" data-testid="pay-button">
              <Lock aria-hidden /> {t("pay")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("payNote")}</p>
            {view.provider === "fake" || process.env.MOYASAR_SECRET_KEY?.startsWith("sk_test_") ? (
              <p className="text-xs text-muted-foreground">{t("testNote")}</p>
            ) : null}
          </form>
        </div>
      </section>
    </PayShell>
  );
}
