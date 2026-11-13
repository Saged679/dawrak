import type { CSSProperties, ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { CheckCircle2, Hourglass, TriangleAlert, XCircle } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { brandStyleVars } from "@/lib/db/brand";
import {
  dateKeyInZone,
  formatGregorian,
  formatHijri,
  formatMoney,
  formatTime,
  type Loc,
} from "@/components/booking/dates";
import type { PaymentView, PayState } from "@/lib/payments/store";
import { AutoRefresh } from "./auto-refresh";

const linkCls =
  "rounded-md px-2 py-2 text-cobalt underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function PayShell({
  view,
  locale,
  children,
}: {
  view: PaymentView;
  locale: Loc;
  children: ReactNode;
}) {
  const name = locale === "en" ? view.tenant.name_en || view.tenant.name_ar : view.tenant.name_ar;
  return (
    <div className="contents" style={brandStyleVars(view.tenant.brand_color) as CSSProperties}>
      <header className="bg-cobalt text-(--brand-fg)">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3 px-4 py-5 sm:px-6">
          <p className="min-w-0 font-heading text-xl font-semibold">{name}</p>
          <Link
            href={`/c/${view.tenant.slug}`}
            className="shrink-0 rounded-md px-2 py-1 text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-fg)"
          >
            {locale === "ar" ? "صفحة العيادة" : "Clinic page"}
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}

export async function BookingSummary({ view, locale }: { view: PaymentView; locale: Loc }) {
  const t = await getTranslations("Payment");
  const tz = view.tenant.timezone;
  const dateKey = dateKeyInZone(view.appointment.startsAt, tz);
  const service =
    locale === "en"
      ? view.appointment.serviceNameEn || view.appointment.serviceNameAr
      : view.appointment.serviceNameAr;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl border border-[#EBC88A] bg-saffron-soft p-4 text-sm">
      <dt className="text-muted-foreground">{t("service")}</dt>
      <dd className="min-w-0 font-medium">{service}</dd>
      <dt className="text-muted-foreground">{t("when")}</dt>
      <dd className="min-w-0 font-medium">
        {formatGregorian(dateKey, locale)} - {formatTime(view.appointment.startsAt, tz, locale)}
        <span className="block text-xs font-normal text-muted-foreground">
          {formatHijri(dateKey, undefined, locale)}
        </span>
      </dd>
      <dt className="text-muted-foreground">{t("deposit")}</dt>
      <dd className="font-medium" data-testid="pay-amount">
        {formatMoney(view.amountMinor / 100, view.currency, locale)}
      </dd>
      <dt className="text-muted-foreground">{t("ref")}</dt>
      <dd className="font-mono text-xs" dir="ltr">
        {view.appointment.id.slice(0, 8).toUpperCase()}
      </dd>
    </dl>
  );
}

const ICONS = {
  paid: CheckCircle2,
  awaiting: Hourglass,
  failed: XCircle,
  expired: TriangleAlert,
  refund_due: TriangleAlert,
} as const;

/** The server-side result of the payment. Everything shown here comes from the database. */
export async function StatusCard({
  view,
  state,
  locale,
  payHref,
}: {
  view: PaymentView;
  state: PayState;
  locale: Loc;
  payHref: string;
}) {
  const t = await getTranslations("Payment");
  const name = locale === "en" ? view.tenant.name_en || view.tenant.name_ar : view.tenant.name_ar;
  const Icon = ICONS[state];
  const copy = {
    paid: [t("paidTitle"), t("paidLead", { clinic: name })],
    awaiting: [t("pendingTitle"), t("pendingLead")],
    failed: [t("retryTitle"), t("retryLead")],
    expired: [t("expiredTitle"), t("expiredLead")],
    refund_due: [t("refundTitle"), t("refundLead")],
  }[state];
  return (
    <section
      aria-labelledby="pay-status-title"
      data-testid="pay-status"
      data-state={state}
      className="rounded-2xl border border-line bg-paper p-4 shadow-sm sm:p-6"
    >
      {state === "awaiting" ? <AutoRefresh /> : null}
      <div className="flex items-start gap-3">
        <Icon className="mt-1 size-6 shrink-0 text-cobalt-deep" aria-hidden />
        <div className="min-w-0">
          <h1 id="pay-status-title" className="font-heading text-xl font-semibold text-ink">
            {copy[0]}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{copy[1]}</p>
        </div>
      </div>
      <div className="mt-4">
        <BookingSummary view={view} locale={locale} />
      </div>
      <div className="mt-4 flex flex-wrap gap-3 text-sm">
        {state === "awaiting" || state === "failed" ? (
          <Link href={payHref} className={linkCls}>
            {t("backToPayment")}
          </Link>
        ) : null}
        {state === "expired" || state === "refund_due" ? (
          <Link href={`/c/${view.tenant.slug}`} className={linkCls}>
            {t("bookAgain")}
          </Link>
        ) : null}
      </div>
    </section>
  );
}
