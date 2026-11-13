import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { BookingSummary, PayShell } from "@/components/payments/pay-views";
import { routing } from "@/i18n/routing";
import { providerForTenant } from "@/lib/payments";
import { loadPaymentView } from "@/lib/payments/store";
import { simulateFakePayment } from "../../actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; slug: string; token: string }> };

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

/** Stand-in for the provider's hosted page. 404 unless this payment belongs to the fake provider. */
export default async function FakeCheckoutPage({ params }: Props) {
  const { locale, slug, token } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const view = await loadPaymentView(token, slug);
  if (!view || view.provider !== "fake" || !view.tenant.is_demo) notFound();
  try {
    if (providerForTenant(view.tenant).name !== "fake") notFound();
  } catch (e) {
    if (e instanceof Error && e.name === "PaymentsUnavailableError") notFound();
    throw e;
  }
  const t = await getTranslations("Payment.fake");

  const hidden = (
    <>
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="locale" value={locale} />
    </>
  );
  return (
    <PayShell view={view} locale={locale}>
      <section aria-labelledby="fake-title" className="rounded-2xl border border-dashed border-cobalt bg-paper p-4 sm:p-6">
        <h1 id="fake-title" className="font-heading text-xl font-semibold text-ink">
          {t("title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("lead")}</p>
        <div className="mt-4">
          <BookingSummary view={view} locale={locale} />
        </div>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <form action={simulateFakePayment} className="flex-1">
            {hidden}
            <input type="hidden" name="outcome" value="paid" />
            <Button type="submit" size="lg" className="h-11 w-full" data-testid="fake-succeed">
              {t("succeed")}
            </Button>
          </form>
          <form action={simulateFakePayment} className="flex-1">
            {hidden}
            <input type="hidden" name="outcome" value="failed" />
            <Button type="submit" size="lg" variant="outline" className="h-11 w-full" data-testid="fake-fail">
              {t("fail")}
            </Button>
          </form>
        </div>
      </section>
    </PayShell>
  );
}
