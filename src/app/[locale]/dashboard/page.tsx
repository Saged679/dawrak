import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import {
  formatGregorian,
  formatHijri,
  formatMoney,
  formatNumber,
  type Loc,
} from "@/components/booking/dates";
import { AppointmentList } from "@/components/dashboard/appointment-list";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { requireSession } from "@/lib/auth/session";
import { loadOverview, loadReminderCounts } from "@/lib/dashboard/queries";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Overview" });
  return { title: t("metaTitle") };
}

export default async function OverviewPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const loc = locale as Loc;
  const session = await requireSession(locale);
  const [t, o, reminders] = await Promise.all([
    getTranslations("Overview"),
    loadOverview(session),
    loadReminderCounts(session),
  ]);
  const tz = session.tenant.timezone;
  const name = session.fullName || session.email;
  const pct =
    o.noShow.rate === null
      ? null
      : new Intl.NumberFormat(loc === "ar" ? "ar-SA-u-nu-arab" : "en-US", {
          style: "percent",
          maximumFractionDigits: 0,
        }).format(o.noShow.rate);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{t("title")}</h1>
        <p className="text-muted-foreground">{t("greeting", { name })}</p>
        <p className="text-sm text-muted-foreground">
          {formatGregorian(o.todayKey, loc, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          {" · "}
          <span lang={loc}>{formatHijri(o.todayKey, undefined, loc)}</span>
        </p>
      </header>

      <section aria-labelledby="facts" className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <h2 id="facts" className="sr-only">
          {t("title")}
        </h2>
        <div className="flex flex-col justify-between gap-3 rounded-2xl bg-cobalt p-6 text-white">
          <p className="text-sm text-white/85">{t("todayCount")}</p>
          <p className="font-heading text-6xl font-bold tabular-nums" data-testid="today-count">
            {formatNumber(o.today.length, loc)}
          </p>
          <Link
            href="/dashboard/calendar"
            className="w-fit rounded-md font-medium text-saffron underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-saffron"
          >
            {t("openCalendar")}
          </Link>
        </div>
        <dl className="grid gap-3">
          <div className="rounded-2xl border border-line bg-paper p-4">
            <dt className="text-sm text-muted-foreground">{t("weekCount")}</dt>
            <dd className="font-heading text-3xl font-semibold tabular-nums" data-testid="week-count">
              {formatNumber(o.weekCount, loc)}
            </dd>
            <dd className="text-xs text-muted-foreground">{t("weekHint")}</dd>
          </div>
          <div className="rounded-2xl border border-line bg-paper p-4">
            <dt className="text-sm text-muted-foreground">{t("noShow")}</dt>
            <dd className="font-heading text-3xl font-semibold tabular-nums" data-testid="no-show">
              {pct ?? "-"}
            </dd>
            <dd className="text-xs text-muted-foreground">
              {pct === null ? t("noShowNone") : t("noShowHint", { n: formatNumber(o.noShow.sample, loc) })}
            </dd>
          </div>
          {o.revenue ? (
            <div className="rounded-2xl bg-saffron-soft p-4" data-testid="revenue-card">
              <dt className="text-sm text-[#6b3f00]">{t("revenue")}</dt>
              <dd className="font-heading text-3xl font-semibold tabular-nums">
                {formatMoney(o.revenue.week, session.tenant.currency, loc)}
              </dd>
              <dd className="text-xs text-[#6b3f00]">
                {t("revenueHint", { month: formatMoney(o.revenue.month, session.tenant.currency, loc) })}
              </dd>
              <dd className="mt-1">
                <Link
                  href="/dashboard/revenue"
                  className="rounded text-sm font-medium text-cobalt-deep underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/60"
                >
                  {t("viewRevenue")}
                </Link>
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      {reminders ? (
        <section aria-labelledby="rem-h" data-testid="reminders-card" className="rounded-2xl border border-line bg-paper p-4">
          <h2 id="rem-h" className="font-heading text-lg font-semibold">
            {t("remindersTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("remindersLead")}</p>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
            {(["pending", "sent", "failed"] as const).map((k) => (
              <div key={k} className="min-w-0 rounded-xl bg-mist/60 p-3">
                <dt className="text-xs text-muted-foreground">
                  {t(k === "pending" ? "remindersPending" : k === "sent" ? "remindersSent" : "remindersFailed")}
                </dt>
                <dd className="font-heading text-2xl font-semibold tabular-nums" data-testid={`reminders-${k}`}>
                  {formatNumber(reminders[k], loc)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section aria-labelledby="today-h" className="flex flex-col gap-3">
        <h2 id="today-h" className="font-heading text-xl font-semibold">
          {t("todayTitle")}
        </h2>
        <AppointmentList rows={o.today} locale={loc} timezone={tz} empty={t("emptyToday")} />
      </section>

      <section aria-labelledby="up-h" className="flex flex-col gap-3">
        <h2 id="up-h" className="font-heading text-xl font-semibold">
          {t("upcomingTitle")}
        </h2>
        <AppointmentList rows={o.upcoming} locale={loc} timezone={tz} showDate empty={t("emptyUpcoming")} />
      </section>
    </div>
  );
}
