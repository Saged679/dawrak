import { dateKeyInZone, formatGregorian, formatHijri, formatClock } from "@/components/booking/dates";
import { isDateKey, localParts, zonedToUtc } from "@/lib/dashboard/time";

/**
 * Tenant-local time handling for the assistant. The model only ever speaks `date` (YYYY-MM-DD) and `time`
 * (HH:mm, 24 h) in the BUSINESS timezone; this module turns them into the UTC instant with the same helper
 * the dashboard uses (zonedToUtc), so the model never does timezone math.
 */

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function parseClock(time: string): number | null {
  const m = TIME_RE.exec(time.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export const pad2 = (n: number) => String(n).padStart(2, "0");
export const clockOf = (minutes: number) => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;

/**
 * The UTC instant at which the wall clock of `timeZone` reads `date` + `time`. Returns null for an invalid
 * date or time and for a wall-clock time that does not exist (DST gap) or is ambiguous-shifted: the result
 * must read back EXACTLY as requested in that zone.
 */
export function localToInstant(date: string, time: string, timeZone: string): string | null {
  if (!isDateKey(date)) return null;
  const minutes = parseClock(time);
  if (minutes === null) return null;
  const instant = zonedToUtc(date, minutes, timeZone);
  const back = localParts(instant.toISOString(), timeZone);
  if (back.dateKey !== date || back.minutes !== minutes) return null;
  return instant.toISOString();
}

/** Local {date, time} of an instant in the tenant timezone. */
export function instantToLocal(iso: string, timeZone: string): { date: string; time: string; minutes: number } {
  const p = localParts(iso, timeZone);
  return { date: dateKeyInZone(iso, timeZone), time: clockOf(p.minutes), minutes: p.minutes };
}

/** Human text of a local date and time: Gregorian weekday and date, Hijri date, 12 h clock. */
export function describeLocal(
  date: string,
  time: string,
  locale: "ar" | "en",
): { gregorian: string; hijri: string; clock: string; line: string } {
  const gregorian = formatGregorian(date, locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const hijri = formatHijri(date, undefined, locale);
  const clock = formatClock(time, locale);
  return { gregorian, hijri, clock, line: `${gregorian} (${hijri}) ${locale === "ar" ? "الساعة" : "at"} ${clock}` };
}
