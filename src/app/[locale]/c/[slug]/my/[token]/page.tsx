import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarClock, CheckCircle2, Hourglass, Info, TriangleAlert } from "lucide-react";
import {
  addDays,
  dateKeyInZone,
  formatGregorian,
  formatHijri,
  formatMoney,
  formatTime,
  type Loc,
} from "@/components/booking/dates";
import { PortalShell } from "@/components/portal/portal-shell";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import {
  loadPortal,
  loadRescheduleSlots,
  type Portal,
  type PortalAppointment,
} from "@/lib/customer/portal";
import { CANCEL_WINDOW_HOURS, RESCHEDULE_WINDOW_DAYS, canChange } from "@/lib/customer/policy";
import { cancelAppointment, rescheduleAppointment } from "../actions";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; slug: string; token: string }>;
  searchParams: Promise<{ booked?: string; done?: string; error?: string; reschedule?: string; day?: string }>;
};

// The URL carries the secret token: never index it and never send it in a Referer header.
export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Portal" });
  return { title: t("metaTitle"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

const ERRORS = [
  "slot_taken",
  "too_far",
  "too_many_bookings",
  "try_again",
  "too_late",
  "rate_limited",
  "not_found",
  "pick_time",
  "generic",
] as const;
type ErrorCode = (typeof ERRORS)[number];

const pick = (loc: Loc, ar: string | null, en: string | null) => (loc === "en" ? en || ar || "" : ar || en || "");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const linkCls =
  "inline-flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-medium text-cobalt underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const chipCls =
  "block rounded-full border-[1.5px] border-line bg-paper px-4 py-2 text-sm transition-colors peer-checked:border-cobalt peer-checked:bg-sky peer-checked:font-semibold peer-checked:text-cobalt-deep peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring motion-reduce:transition-none";

export default async function PatientPage({ params, searchParams }: Props) {
  const { locale, slug, token } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  // 404 with no hint: malformed, unknown, expired and other-clinic tokens all end here.
  const portal = await loadPortal(slug, token);
  if (!portal) notFound();

  const sp = await searchParams;
  const t = await getTranslations("Portal");
  const loc = locale as Loc;
  const now = new Date();
  const tz = portal.tenant.timezone;
  const name = pick(loc, portal.tenant.name_ar, portal.tenant.name_en);

  const upcoming = portal.appointments
    .filter((a) => (a.status === "pending_payment" || a.status === "confirmed") && new Date(a.startsAt) > now)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = portal.appointments.filter((a) => !upcoming.includes(a));

  const rescheduleId = sp.reschedule && UUID_RE.test(sp.reschedule) ? sp.reschedule : null;
  const target = rescheduleId ? upcoming.find((a) => a.id === rescheduleId) : undefined;
  const error = (ERRORS as readonly string[]).includes(sp.error ?? "") ? (sp.error as ErrorCode) : null;
  const justBooked = sp.booked && UUID_RE.test(sp.booked) ? portal.appointments.find((a) => a.id === sp.booked) : undefined;

  return (
    <PortalShell
      slug={slug}
      name={name}
      brandColor={portal.tenant.brand_color}
      locale={loc}
      backLabel={t("backToClinic")}
    >
      <div className="flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h1 className="break-words font-heading text-2xl font-semibold text-ink">
            {t("title", { name: portal.fullName })}
          </h1>
          <p className="text-sm text-muted-foreground">{t("lead")}</p>
        </header>

        {portal.tenant.is_demo ? (
          <p role="note" className="flex items-start gap-2 rounded-xl bg-saffron-soft px-3 py-2 text-sm text-[#6b3f00]">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {t("demoNotice")}{" "}
              <Link
                href="/demo/mailbox"
                className="rounded-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {t("openMailbox")}
              </Link>
            </span>
          </p>
        ) : null}

        {justBooked ? (
          <section
            aria-labelledby="booked-title"
            data-testid="booking-confirmation"
            className="rounded-2xl border border-cobalt bg-sky/60 p-4"
          >
            <div className="flex items-start gap-3">
              {justBooked.status === "pending_payment" ? (
                <Hourglass className="mt-1 size-6 shrink-0 text-cobalt-deep" aria-hidden />
              ) : (
                <CheckCircle2 className="mt-1 size-6 shrink-0 text-cobalt" aria-hidden />
              )}
              <div className="min-w-0">
                <h2 id="booked-title" className="font-heading text-xl font-semibold text-ink">
                  {justBooked.status === "pending_payment" ? t("bookedPendingTitle") : t("bookedTitle")}
                </h2>
                <p className="mt-1 text-sm text-ink">{t("bookedLead")}</p>
                <p className="mt-2 text-sm text-ink" data-testid="manage-link-note">
                  {t("bookmark")}
                </p>
              </div>
            </div>
          </section>
        ) : null}

        {sp.done === "cancelled" || sp.done === "rescheduled" ? (
          <p
            role="status"
            data-testid="portal-done"
            className="flex items-start gap-2 rounded-xl border border-cobalt bg-sky/60 p-3 text-sm text-ink"
          >
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-cobalt" aria-hidden />
            {sp.done === "cancelled" ? t("doneCancelled") : t("doneRescheduled")}
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            data-testid="portal-error"
            className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-ink"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            {t(`errors.${error}`, { hours: CANCEL_WINDOW_HOURS })}
          </p>
        ) : null}

        {target ? (
          <ReschedulePanel
            portal={portal}
            appointment={target}
            token={token}
            slug={slug}
            loc={loc}
            now={now}
            day={sp.day && DAY_RE.test(sp.day) ? sp.day : null}
          />
        ) : null}

        <section aria-labelledby="up-title" className="flex flex-col gap-3">
          <h2 id="up-title" className="font-heading text-lg font-semibold text-ink">
            {t("upcomingTitle")}
          </h2>
          {upcoming.length === 0 ? (
            <p className="rounded-xl border border-line bg-paper p-4 text-sm text-muted-foreground">
              {t("noUpcoming")}{" "}
              <Link href={`/c/${slug}`} className={linkCls}>
                {t("bookNew")}
              </Link>
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {upcoming.map((a) => (
                <li key={a.id}>
                  <AppointmentCard a={a} loc={loc} tz={tz} now={now}>
                    <Actions a={a} token={token} slug={slug} loc={loc} now={now} />
                  </AppointmentCard>
                </li>
              ))}
            </ul>
          )}
        </section>

        {past.length > 0 ? (
          <section aria-labelledby="past-title" className="flex flex-col gap-3">
            <h2 id="past-title" className="font-heading text-lg font-semibold text-ink">
              {t("pastTitle")}
            </h2>
            <ul className="flex flex-col gap-3">
              {past.slice(0, 20).map((a) => (
                <li key={a.id}>
                  <AppointmentCard a={a} loc={loc} tz={tz} now={now} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </PortalShell>
  );
}

async function AppointmentCard({
  a,
  loc,
  tz,
  now,
  children,
}: {
  a: PortalAppointment;
  loc: Loc;
  tz: string;
  now: Date;
  children?: React.ReactNode;
}) {
  const t = await getTranslations("Portal");
  const dateKey = dateKeyInZone(a.startsAt, tz);
  const status =
    a.status === "confirmed" && new Date(a.startsAt) <= now ? "past" : a.status;
  const deposit =
    a.depositStatus === "paid"
      ? t("deposit.paid", { amount: formatMoney(a.depositAmount ?? 0, a.currency, loc) })
      : a.depositStatus === "refund_due"
        ? t("deposit.refund_due")
        : a.depositStatus === "refunded"
          ? t("deposit.refunded")
          : a.status === "pending_payment"
            ? t("deposit.awaiting")
            : null;
  return (
    <article
      data-testid="portal-appointment"
      data-status={a.status}
      className="min-w-0 rounded-2xl border border-line bg-paper p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-heading text-base font-semibold text-ink">
          {pick(loc, a.serviceNameAr, a.serviceNameEn)}
        </h3>
        <span
          data-testid="portal-status"
          className="shrink-0 rounded-full bg-sky px-3 py-1 text-xs font-medium text-cobalt-deep"
        >
          {t(`status.${status}`)}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("provider")}</dt>
        <dd className="min-w-0 break-words font-medium">{pick(loc, a.providerNameAr, a.providerNameEn)}</dd>
        <dt className="text-muted-foreground">{t("when")}</dt>
        <dd className="min-w-0 font-medium">
          {formatGregorian(dateKey, loc)} - {formatTime(a.startsAt, tz, loc)}
          <span className="block text-xs font-normal text-muted-foreground">
            {t("hijri")} {formatHijri(dateKey, undefined, loc)}
          </span>
        </dd>
        <dt className="text-muted-foreground">{t("price")}</dt>
        <dd className="font-medium">{formatMoney(a.price, a.currency, loc)}</dd>
        {deposit ? (
          <>
            <dt className="text-muted-foreground">{t("depositLabel")}</dt>
            <dd className="font-medium" data-testid="portal-deposit">
              {deposit}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("ref")}</dt>
        <dd className="font-mono text-xs" dir="ltr">
          {a.id.slice(0, 8).toUpperCase()}
        </dd>
      </dl>
      {children}
    </article>
  );
}

async function Actions({
  a,
  token,
  slug,
  loc,
  now,
}: {
  a: PortalAppointment;
  token: string;
  slug: string;
  loc: Loc;
  now: Date;
}) {
  const t = await getTranslations("Portal");
  if (!canChange(a.status, a.startsAt, now)) {
    return <p className="mt-3 text-sm text-muted-foreground">{t("tooLateNote", { hours: CANCEL_WINDOW_HOURS })}</p>;
  }
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/c/${slug}/my/${token}?reschedule=${a.id}`} className={linkCls} data-testid="reschedule-link">
          <CalendarClock className="me-1.5 size-4" aria-hidden />
          {t("reschedule")}
        </Link>
      </div>
      <details className="group rounded-xl border border-line">
        <summary className="flex min-h-11 cursor-pointer items-center rounded-xl px-3 py-2 text-sm font-medium text-destructive focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {t("cancel")}
        </summary>
        <form action={cancelAppointment} method="post" className="flex flex-col gap-2 border-t border-line p-3">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="locale" value={loc} />
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="appointmentId" value={a.id} />
          <p className="text-sm text-ink">{t("cancelConfirm", { hours: CANCEL_WINDOW_HOURS })}</p>
          <Button type="submit" variant="destructive" size="lg" className="h-11 w-full text-base sm:w-fit" data-testid="cancel-confirm">
            {t("cancelYes")}
          </Button>
        </form>
      </details>
    </div>
  );
}

async function ReschedulePanel({
  portal,
  appointment,
  token,
  slug,
  loc,
  now,
  day,
}: {
  portal: Portal;
  appointment: PortalAppointment;
  token: string;
  slug: string;
  loc: Loc;
  now: Date;
  day: string | null;
}) {
  const t = await getTranslations("Portal");
  const tz = portal.tenant.timezone;
  const today = dateKeyInZone(now, tz);
  const slots = canChange(appointment.status, appointment.startsAt, now)
    ? (
        await loadRescheduleSlots(portal, appointment, today, addDays(today, RESCHEDULE_WINDOW_DAYS - 1)).catch(() => [])
      ).filter((s) => s.start !== appointment.startsAt)
    : [];
  const byDay = new Map<string, typeof slots>();
  for (const s of slots) {
    const k = dateKeyInZone(s.start, tz);
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  const days = [...byDay.keys()].sort();
  const chosen = day && byDay.has(day) ? day : (days[0] ?? null);
  const base = `/c/${slug}/my/${token}?reschedule=${appointment.id}`;

  return (
    <section
      aria-labelledby="resched-title"
      data-testid="reschedule-panel"
      className="rounded-2xl border border-cobalt bg-paper p-4 shadow-sm"
    >
      <h2 id="resched-title" className="font-heading text-lg font-semibold text-ink">
        {t("rescheduleTitle", { service: pick(loc, appointment.serviceNameAr, appointment.serviceNameEn) })}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("rescheduleLead")}</p>
      {days.length === 0 || !chosen ? (
        <p className="mt-3 text-sm text-muted-foreground">{t("noSlots")}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          <nav aria-label={t("dayLegend")}>
            <ul className="flex flex-wrap gap-2">
              {days.map((k) => (
                <li key={k}>
                  <Link
                    href={`${base}&day=${k}`}
                    aria-current={k === chosen ? "true" : undefined}
                    className={`block min-h-11 rounded-xl border-[1.5px] px-3 py-1.5 text-center text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                      k === chosen ? "border-cobalt bg-sky font-semibold text-cobalt-deep" : "border-line bg-paper text-ink"
                    }`}
                  >
                    <span className="block">{formatGregorian(k, loc, { weekday: "short", day: "numeric", month: "short" })}</span>
                    <span className="block text-xs text-muted-foreground">{formatHijri(k, { day: "numeric", month: "short" }, loc)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <form action={rescheduleAppointment} method="post" className="flex flex-col gap-3">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="locale" value={loc} />
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="appointmentId" value={appointment.id} />
            <fieldset className="min-w-0">
              <legend className="mb-1 text-sm font-medium text-ink">
                {t("timesFor", { date: formatGregorian(chosen, loc) })}
              </legend>
              <p className="mb-2 text-xs text-muted-foreground">
                {t("hijri")} {formatHijri(chosen, undefined, loc)} - {t("timezoneNote", { zone: tz })}
              </p>
              <div className="flex flex-wrap gap-2">
                {(byDay.get(chosen) ?? []).map((s) => (
                  <label key={s.start} className="relative">
                    <input type="radio" name="startsAt" value={s.start} required className="peer sr-only" />
                    <span className={chipCls}>{formatTime(s.start, tz, loc)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="lg" className="h-11 text-base" data-testid="reschedule-confirm">
                {t("rescheduleConfirm")}
              </Button>
              <Link href={`/c/${slug}/my/${token}`} className={linkCls}>
                {t("close")}
              </Link>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
