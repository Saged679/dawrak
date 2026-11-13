/** Date helpers for the booking flow. Everything is computed in the tenant timezone. */

export type Loc = "ar" | "en";

const numbering = (locale: Loc) => (locale === "ar" ? "ar-SA-u-nu-arab" : "en-US");

/** YYYY-MM-DD of an instant in the given timezone. */
export function dateKeyInZone(instant: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(typeof instant === "string" ? new Date(instant) : instant);
}

export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Noon UTC of the date key: safe to format with timeZone "UTC" without day shifts. */
function keyToDate(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00Z`);
}

export function formatGregorian(
  dateKey: string,
  locale: Loc,
  opts: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long" },
): string {
  return new Intl.DateTimeFormat(numbering(locale), { ...opts, timeZone: "UTC" }).format(
    keyToDate(dateKey),
  );
}

/**
 * Hijri (Umm al-Qura) date. By default it is Arabic ("١٣ جمادى الآخرة ١٤٤٨ هـ"), which is what the
 * public booking page shows. Pass `locale` to render it in the page language instead: "en" gives
 * "Jumada II 13, 1448 AH" (Latin digits, transliterated month), so an English sentence never
 * contains Arabic script.
 */
export function formatHijri(
  dateKey: string,
  opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" },
  locale: Loc = "ar",
): string {
  const tag = locale === "en" ? "en-US-u-ca-islamic-umalqura" : "ar-SA-u-ca-islamic-umalqura";
  return new Intl.DateTimeFormat(tag, { ...opts, timeZone: "UTC" }).format(keyToDate(dateKey));
}

export function formatTime(instant: string, timeZone: string, locale: Loc): string {
  return new Intl.DateTimeFormat(numbering(locale), {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(instant));
}

export function formatClock(hhmm: string, locale: Loc): string {
  const [h, m] = hhmm.split(":").map(Number);
  return new Intl.DateTimeFormat(numbering(locale), {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(Date.UTC(2000, 0, 1, h, m)));
}

export function formatMoney(amount: number, currency: string, locale: Loc): string {
  return new Intl.NumberFormat(numbering(locale), {
    style: "currency",
    currency,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);
}

export function formatNumber(n: number, locale: Loc): string {
  return new Intl.NumberFormat(numbering(locale)).format(n);
}

export function weekdayName(weekday: number, locale: Loc): string {
  // 2000-01-02 was a Sunday
  return new Intl.DateTimeFormat(numbering(locale), { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(2000, 0, 2 + weekday)),
  );
}

/** Full weekday name; 0 = Sunday. */
export function weekdayLong(weekday: number, locale: Loc): string {
  return new Intl.DateTimeFormat(numbering(locale), { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2000, 0, 2 + weekday)),
  );
}

export type HoursGroup = { from: number; to: number; start: string; end: string };

/** Groups consecutive weekdays that share the same hours. */
export function groupHours(
  rows: { weekday: number; start: string; end: string }[],
): HoursGroup[] {
  const out: HoursGroup[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.to === r.weekday - 1 && last.start === r.start && last.end === r.end) {
      last.to = r.weekday;
    } else {
      out.push({ from: r.weekday, to: r.weekday, start: r.start, end: r.end });
    }
  }
  return out;
}

export const BOOKING_WINDOW_DAYS = 14;
