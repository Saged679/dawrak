import { addDays, dateKeyInZone } from "@/components/booking/dates";

export { addDays, dateKeyInZone };

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_KEY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `timeZone` reads `dateKey` + `minutes`. */
export function zonedToUtc(dateKey: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let t = guess - offsetMs(new Date(guess), timeZone);
  t = guess - offsetMs(new Date(t), timeZone); // second pass handles DST edges
  return new Date(t);
}

/** [start, end) of a local day as ISO instants. */
export function dayRange(dateKey: string, timeZone: string): { from: string; to: string } {
  return {
    from: zonedToUtc(dateKey, 0, timeZone).toISOString(),
    to: zonedToUtc(addDays(dateKey, 1), 0, timeZone).toISOString(),
  };
}

/** Sunday on or before the date (the Saudi week starts on Sunday). */
export function weekStartKey(dateKey: string): string {
  const dow = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return addDays(dateKey, -dow);
}

/** Local calendar day and minutes since local midnight of an instant. */
export function localParts(iso: string, timeZone: string): { dateKey: string; minutes: number } {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { dateKey: dateKeyInZone(d, timeZone), minutes: n("hour") * 60 + n("minute") };
}

export type BlockGeometry = { top: number; height: number };

/** Pixel position of an appointment inside a day column. */
export function blockGeometry(
  startMin: number,
  endMin: number,
  gridStartMin: number,
  pxPerHour: number,
): BlockGeometry {
  const px = pxPerHour / 60;
  return {
    top: Math.max(0, (startMin - gridStartMin) * px),
    height: Math.max(24, (endMin - startMin) * px - 2),
  };
}

/** Whole-hour grid bounds that cover opening hours and every appointment shown. */
export function gridBounds(
  hours: { start: number; end: number }[],
  items: { startMin: number; endMin: number }[],
): { startHour: number; endHour: number } {
  let lo = hours.length ? Math.min(...hours.map((h) => h.start)) : 9 * 60;
  let hi = hours.length ? Math.max(...hours.map((h) => h.end)) : 21 * 60;
  for (const i of items) {
    lo = Math.min(lo, i.startMin);
    hi = Math.max(hi, i.endMin);
  }
  return { startHour: Math.floor(lo / 60), endHour: Math.min(24, Math.ceil(hi / 60)) };
}

export function parseTimeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}
