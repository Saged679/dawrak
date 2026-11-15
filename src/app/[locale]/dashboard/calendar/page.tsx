import type { Metadata } from "next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { formatGregorian, formatHijri, type Loc } from "@/components/booking/dates";
import { CalendarView, type CalendarColumn, type CalendarItem } from "@/components/dashboard/calendar-view";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { canPickProvider, canSeeRevenue } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { listAppointments, listProviders, listWorkingWindows } from "@/lib/dashboard/queries";
import {
  addDays,
  dateKeyInZone,
  dayRange,
  gridBounds,
  isDateKey,
  localParts,
  weekStartKey,
} from "@/lib/dashboard/time";
import { cn } from "@/lib/utils";

type SP = Record<string, string | string[] | undefined>;
type Props = { params: Promise<{ locale: string }>; searchParams: Promise<SP> };

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Calendar" });
  return { title: t("metaTitle") };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const chip =
  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/60";

export default async function CalendarPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const loc = locale as Loc;
  const session = await requireSession(locale);
  const sp = await searchParams;
  const t = await getTranslations("Calendar");

  const tz = session.tenant.timezone;
  const todayKey = dateKeyInZone(new Date(), tz);
  const dateParam = first(sp.date);
  const date = isDateKey(dateParam) ? dateParam : todayKey;
  const view: "day" | "week" = first(sp.view) === "week" ? "week" : "day";
  const showCancelled = first(sp.cancelled) === "1";

  // A provider is limited to themselves: the ?provider= value is ignored for that role, and
  // RLS would return nothing for anyone else's rows anyway.
  const providers = await listProviders(session);
  const requested = first(sp.provider);
  const picked = canPickProvider(session.role)
    ? providers.find((p) => p.id === requested)
    : providers[0];
  const weekProvider = picked ?? providers[0] ?? null;
  const dayProviders = picked ? [picked] : providers;

  const weekStart = weekStartKey(date);
  const rangeFrom = view === "day" ? dayRange(date, tz).from : dayRange(weekStart, tz).from;
  const rangeTo = view === "day" ? dayRange(date, tz).to : dayRange(addDays(weekStart, 7), tz).from;
  const restrictTo =
    session.role === "provider"
      ? (session.providerId ?? "00000000-0000-0000-0000-000000000000")
      : view === "week"
        ? (weekProvider?.id ?? null)
        : (picked?.id ?? null);

  const [rows, windows] = await Promise.all([
    providers.length === 0
      ? Promise.resolve([])
      : listAppointments(session, { from: rangeFrom, to: rangeTo }, { providerId: restrictTo }),
    listWorkingWindows(session),
  ]);

  const showPrice = canSeeRevenue(session.role);
  const items: CalendarItem[] = rows
    .filter((r) => showCancelled || r.status !== "cancelled")
    .map((r) => {
      const s = localParts(r.startsAt, tz);
      const e = localParts(r.endsAt, tz);
      const endMin = e.dateKey === s.dateKey ? e.minutes : 24 * 60;
      return {
        ...r,
        locked: session.tenant.is_demo && r.seeded,
        price: showPrice ? r.price : null,
        dateKey: s.dateKey,
        startMin: s.minutes,
        endMin,
      };
    });

  const { startHour, endHour } = gridBounds(windows, items);
  const pick = (n: { name_ar: string; name_en: string | null }) =>
    loc === "en" ? n.name_en || n.name_ar : n.name_ar;

  let columns: CalendarColumn[];
  if (view === "day") {
    columns = dayProviders.map((p) => ({
      key: p.id,
      title: pick(p),
      subtitle: (loc === "en" ? p.title_en || p.title_ar : p.title_ar) ?? null,
      isToday: false,
      items: items.filter((i) => i.providerId === p.id),
    }));
  } else {
    columns = Array.from({ length: 7 }, (_, i) => {
      const key = addDays(weekStart, i);
      return {
        key,
        title: formatGregorian(key, loc, { weekday: "short" }),
        subtitle: formatGregorian(key, loc, { day: "numeric", month: "short" }),
        isToday: key === todayKey,
        items: items.filter((it) => it.dateKey === key),
      };
    });
  }

  const href = (over: Partial<{ date: string; view: string; provider: string | null; cancelled: boolean }>) => {
    const q: Record<string, string> = {
      view: over.view ?? view,
      date: over.date ?? date,
    };
    const prov = over.provider === undefined ? picked?.id : (over.provider ?? undefined);
    if (prov && canPickProvider(session.role)) q.provider = prov;
    if (over.cancelled ?? showCancelled) q.cancelled = "1";
    return { pathname: "/dashboard/calendar" as const, query: q };
  };

  const step = view === "day" ? 1 : 7;
  const rangeEndKey = addDays(weekStart, 6);
  const headline =
    view === "day"
      ? formatGregorian(date, loc, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
      : `${formatGregorian(weekStart, loc, { day: "numeric", month: "long" })} - ${formatGregorian(rangeEndKey, loc, { day: "numeric", month: "long", year: "numeric" })}`;
  const hijri =
    view === "day"
      ? formatHijri(date, undefined, loc)
      : `${formatHijri(weekStart, { day: "numeric", month: "long" }, loc)} - ${formatHijri(rangeEndKey, undefined, loc)}`;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{t("title")}</h1>
        <p className="font-medium" data-testid="cal-date">
          {headline}
        </p>
        <p className="text-sm text-muted-foreground" data-testid="cal-hijri" lang={loc}>
          {t("hijri", { date: hijri })}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Link
            href={href({ date: addDays(date, -step) })}
            aria-label={t("prev")}
            className={cn(chip, "w-11 justify-center border-line bg-paper px-0 hover:bg-sky")}
          >
            <ChevronRight className="size-4 ltr:hidden" aria-hidden />
            <ChevronLeft className="size-4 rtl:hidden" aria-hidden />
          </Link>
          <Link href={href({ date: todayKey })} className={cn(chip, "border-line bg-paper hover:bg-sky")}>
            {t("today")}
          </Link>
          <Link
            href={href({ date: addDays(date, step) })}
            aria-label={t("next")}
            className={cn(chip, "w-11 justify-center border-line bg-paper px-0 hover:bg-sky")}
          >
            <ChevronLeft className="size-4 ltr:hidden" aria-hidden />
            <ChevronRight className="size-4 rtl:hidden" aria-hidden />
          </Link>
        </div>
        <nav aria-label={t("viewSwitch")} className="flex gap-1">
          {(["day", "week"] as const).map((v) => (
            <Link
              key={v}
              href={href({ view: v })}
              aria-current={view === v ? "page" : undefined}
              className={cn(
                chip,
                view === v ? "border-cobalt bg-cobalt text-white" : "border-line bg-paper hover:bg-sky",
              )}
            >
              {t(v)}
            </Link>
          ))}
        </nav>
        <Link
          href={href({ cancelled: !showCancelled })}
          className={cn(chip, "border-line bg-paper hover:bg-sky")}
          data-testid="toggle-cancelled"
        >
          {showCancelled ? t("hideCancelled") : t("showCancelled")}
        </Link>
      </div>

      {canPickProvider(session.role) && providers.length > 1 ? (
        <nav aria-label={t("provider")} className="flex flex-wrap gap-2">
          {view === "day" ? (
            <Link
              href={href({ provider: null })}
              aria-current={!picked ? "page" : undefined}
              className={cn(chip, !picked ? "border-cobalt bg-sky text-cobalt-deep" : "border-line bg-paper hover:bg-sky")}
            >
              {t("allProviders")}
            </Link>
          ) : null}
          {providers.map((p) => {
            const active = view === "day" ? picked?.id === p.id : weekProvider?.id === p.id;
            return (
              <Link
                key={p.id}
                href={href({ provider: p.id })}
                aria-current={active ? "page" : undefined}
                className={cn(chip, active ? "border-cobalt bg-sky text-cobalt-deep" : "border-line bg-paper hover:bg-sky")}
              >
                {pick(p)}
              </Link>
            );
          })}
        </nav>
      ) : null}

      {providers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-4 text-muted-foreground">{t("noProviders")}</p>
      ) : (
        <CalendarView
          columns={columns}
          startHour={startHour}
          endHour={endHour}
          timezone={tz}
          currency={session.tenant.currency}
          locale={loc}
          role={session.role}
          todayKey={todayKey}
        />
      )}
    </div>
  );
}
