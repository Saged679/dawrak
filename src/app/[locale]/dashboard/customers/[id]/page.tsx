import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import {
  dateKeyInZone,
  formatGregorian,
  formatMoney,
  formatNumber,
  formatTime,
  type Loc,
} from "@/components/booking/dates";
import { BackLink } from "@/components/dashboard/manage/back-link";
import { StatusBadge } from "@/components/dashboard/status";
import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { canSeeRevenue } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { getCustomerDetail } from "@/lib/dashboard/catalog";

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Customers" });
  return { title: t("detailMetaTitle") };
}

export default async function CustomerPage({ params }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale) || !z.uuid().safeParse(id).success) notFound();
  setRequestLocale(locale);
  const loc = locale as Loc;
  const session = await requireSession(locale);
  const detail = await getCustomerDetail(session, id);
  // Not found and "not your customer" (provider) look the same: back to the list.
  if (!detail) redirect({ href: "/dashboard/customers", locale });
  const { customer, history, stats } = detail!;
  const [t, ts] = await Promise.all([getTranslations("Customers"), getTranslations("Dash.status")]);
  const tz = session.tenant.timezone;
  const showPrice = canSeeRevenue(session.role);
  const pick = (n: { name_ar: string; name_en: string | null }) =>
    loc === "en" ? n.name_en || n.name_ar : n.name_ar;
  const day = (iso: string) =>
    formatGregorian(dateKeyInZone(iso, tz), loc, { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <BackLink href="/dashboard/customers" />
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold sm:text-3xl" data-testid="customer-name">
          {customer.full_name}
        </h1>
        <p className="text-muted-foreground">{t("since", { date: day(customer.created_at) })}</p>
      </header>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-2xl border border-line bg-paper p-4 text-sm">
        <dt className="text-muted-foreground">{t("detail.phone")}</dt>
        <dd dir="ltr" className="text-start tabular-nums">
          <a href={`tel:${customer.phone}`} className="text-cobalt-deep underline-offset-4 hover:underline">
            {customer.phone}
          </a>
        </dd>
        <dt className="text-muted-foreground">{t("detail.email")}</dt>
        <dd dir="ltr" className="break-all text-start">
          {customer.email ?? "-"}
        </dd>
        <dt className="text-muted-foreground">{t("detail.language")}</dt>
        <dd>{customer.locale === "en" ? "English" : "العربية"}</dd>
      </dl>

      <dl className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl bg-sky p-4">
          <dt className="text-xs text-cobalt-deep">{t("columns.visits")}</dt>
          <dd className="font-heading text-2xl font-semibold tabular-nums">{formatNumber(stats.visits, loc)}</dd>
        </div>
        <div className="rounded-2xl border border-line bg-paper p-4">
          <dt className="text-xs text-muted-foreground">{t("columns.noShows")}</dt>
          <dd className="font-heading text-2xl font-semibold tabular-nums">{formatNumber(stats.noShows, loc)}</dd>
        </div>
        <div className="rounded-2xl border border-line bg-paper p-4">
          <dt className="text-xs text-muted-foreground">{t("columns.lastVisit")}</dt>
          <dd className="text-sm font-semibold">{stats.lastVisit ? day(stats.lastVisit) : t("never")}</dd>
        </div>
      </dl>

      <section aria-labelledby="history-h" className="flex flex-col gap-3">
        <h2 id="history-h" className="font-heading text-xl font-semibold">
          {t("history.title")}
        </h2>
        {history.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-4 text-muted-foreground">{t("history.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="customer-history">
            {history.map((a) => (
              <li
                key={a.id}
                className="flex flex-col gap-1 rounded-xl border border-line bg-paper p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    {day(a.startsAt)} · {formatTime(a.startsAt, tz, loc)}
                  </p>
                  <p className="text-muted-foreground">
                    {pick(a.service)} · {pick(a.provider)}
                    {showPrice ? ` · ${formatMoney(a.price, session.tenant.currency, loc)}` : ""}
                  </p>
                </div>
                <StatusBadge status={a.status} label={ts(a.status)} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
