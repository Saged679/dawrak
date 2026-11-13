/**
 * Pure validation for the catalogue / settings forms (no I/O): shared by the server actions, the
 * client forms and the unit tests. The server actions are the real gate; the client only reuses
 * these functions to give an answer before the round trip.
 */
import { z } from "zod";
import { isDateKey, zonedToUtc } from "./time";

// ---------- small building blocks ----------

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Optional free text: missing or blank becomes null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

/** Decimal typed in a form field ("12", "12.5", "12.50"). Digits only: no signs, no exponent. */
const decimal = (maxIntDigits: number) =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{1,${maxIntDigits}}(\\.\\d{1,2})?$`))
    .transform(Number);

const wholeNumber = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,5}$/)
    .transform(Number)
    .refine((n) => n >= min && n <= max);

// ---------- services ----------

export const serviceInput = z.object({
  id: z.uuid().optional(),
  name_ar: trimmed(1, 100),
  name_en: trimmed(1, 100),
  description_ar: optionalText(500),
  description_en: optionalText(500),
  duration_min: wholeNumber(5, 720),
  buffer_min: wholeNumber(0, 240),
  price: decimal(6),
  is_active: z.boolean(),
  provider_ids: z.array(z.uuid()).max(200),
});
export type ServiceInput = z.input<typeof serviceInput>;

// ---------- providers ----------

export const providerInput = z.object({
  id: z.uuid().optional(),
  name_ar: trimmed(1, 100),
  name_en: trimmed(1, 100),
  title_ar: optionalText(100),
  title_en: optionalText(100),
  bio_ar: optionalText(1000),
  bio_en: optionalText(1000),
  is_active: z.boolean(),
});
export type ProviderInput = z.input<typeof providerInput>;

// ---------- working hours ----------

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export type TimeRange = { start: string; end: string };
export type DayHours = { weekday: number; ranges: TimeRange[] };

export type HoursProblem = "hours_invalid" | "hours_inverted" | "hours_overlap";
export type HoursCheck =
  | { ok: true; rows: { weekday: number; start: string; end: string }[] }
  | { ok: false; code: HoursProblem; weekday: number };

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** "09:00:00" (Postgres time) to "09:00". */
export function trimSeconds(t: string): string {
  return t.slice(0, 5);
}

export const hoursInput = z.object({
  providerId: z.uuid(),
  days: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        ranges: z
          .array(z.object({ start: z.string().regex(HHMM), end: z.string().regex(HHMM) }))
          .max(6),
      }),
    )
    .max(7),
});

/**
 * Each range must end after it starts (the table has `check (end_time > start_time)`), and the
 * ranges of one day must not overlap. Touching ranges (09:00-12:00, 12:00-15:00) are allowed.
 * Returns the rows to store, sorted by weekday then start.
 */
export function validateWeek(days: DayHours[]): HoursCheck {
  const seen = new Set<number>();
  const rows: { weekday: number; start: string; end: string }[] = [];
  for (const day of [...days].sort((a, b) => a.weekday - b.weekday)) {
    if (seen.has(day.weekday)) return { ok: false, code: "hours_invalid", weekday: day.weekday };
    seen.add(day.weekday);
    const sorted = [...day.ranges].sort((a, b) => a.start.localeCompare(b.start));
    for (const r of sorted) {
      if (!HHMM.test(r.start) || !HHMM.test(r.end)) {
        return { ok: false, code: "hours_invalid", weekday: day.weekday };
      }
      if (toMinutes(r.end) <= toMinutes(r.start)) {
        return { ok: false, code: "hours_inverted", weekday: day.weekday };
      }
    }
    for (let i = 1; i < sorted.length; i++) {
      if (toMinutes(sorted[i].start) < toMinutes(sorted[i - 1].end)) {
        return { ok: false, code: "hours_overlap", weekday: day.weekday };
      }
    }
    for (const r of sorted) rows.push({ weekday: day.weekday, start: r.start, end: r.end });
  }
  return { ok: true, rows };
}

// ---------- time off ----------

const LOCAL_DATETIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/** "2026-11-13T09:30" read as wall-clock time in `timeZone`, as a UTC instant. null if invalid. */
export function localDateTimeToUtc(value: string, timeZone: string): Date | null {
  const m = LOCAL_DATETIME.exec(value);
  if (!m || !isDateKey(m[1])) return null;
  return zonedToUtc(m[1], Number(m[2]) * 60 + Number(m[3]), timeZone);
}

export const timeOffInput = z.object({
  providerId: z.uuid(),
  start: z.string().regex(LOCAL_DATETIME),
  end: z.string().regex(LOCAL_DATETIME),
  reason: optionalText(200),
});

/** Longest single time-off block accepted (a sabbatical is several rows, not one huge one). */
export const MAX_TIME_OFF_DAYS = 366;

export function checkTimeOff(
  start: string,
  end: string,
  timeZone: string,
): { ok: true; startsAt: string; endsAt: string } | { ok: false } {
  const a = localDateTimeToUtc(start, timeZone);
  const b = localDateTimeToUtc(end, timeZone);
  if (!a || !b || b <= a) return { ok: false };
  if (b.getTime() - a.getTime() > MAX_TIME_OFF_DAYS * 86_400_000) return { ok: false };
  return { ok: true, startsAt: a.toISOString(), endsAt: b.toISOString() };
}

// ---------- tenant settings ----------

/**
 * Time zones and currencies the owner can pick. A closed list on purpose: the booking functions
 * run `at time zone <tenants.timezone>`, so a name Postgres does not know would break slot
 * generation for the whole tenant. A tenant already on another value keeps it (see settingsSchema).
 */
export const TIMEZONES = [
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Kuwait",
  "Asia/Qatar",
  "Asia/Bahrain",
  "Asia/Muscat",
  "Asia/Baghdad",
  "Asia/Amman",
  "Asia/Beirut",
  "Africa/Cairo",
  "Africa/Casablanca",
  "Africa/Tunis",
  "Africa/Algiers",
  "Europe/Istanbul",
  "UTC",
] as const;

export const CURRENCIES = [
  "SAR",
  "AED",
  "KWD",
  "QAR",
  "BHD",
  "OMR",
  "EGP",
  "JOD",
  "USD",
  "EUR",
] as const;

export const BRAND_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Only https images (no data:, javascript:, http mixed content). */
export function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

export function settingsSchema(current: { timezone: string; currency: string }) {
  const zones = new Set<string>([...TIMEZONES, current.timezone]);
  const currencies = new Set<string>([...CURRENCIES, current.currency]);
  return z
    .object({
      name_ar: trimmed(1, 100),
      name_en: trimmed(1, 100),
      timezone: z.string().refine((v) => zones.has(v)),
      currency: z.string().refine((v) => currencies.has(v)),
      deposit_enabled: z.boolean(),
      deposit_type: z.enum(["fixed", "percent"]),
      deposit_value: decimal(8),
      logo_url: z
        .string()
        .trim()
        .max(500)
        .refine((v) => v === "" || isHttpsUrl(v))
        .transform((v) => (v === "" ? null : v)),
      brand_color: z
        .string()
        .trim()
        .refine((v) => v === "" || BRAND_COLOR.test(v))
        .transform((v) => (v === "" ? null : v.toLowerCase())),
    })
    .superRefine((v, ctx) => {
      if (v.deposit_type === "percent" && v.deposit_value > 100) {
        ctx.addIssue({ code: "custom", path: ["deposit_value"], message: "percent" });
      }
      if (v.deposit_enabled && v.deposit_value <= 0) {
        ctx.addIssue({ code: "custom", path: ["deposit_value"], message: "deposit" });
      }
    });
}

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
export function readableOn(hex: string): "#ffffff" | "#101c3a" {
  if (!BRAND_COLOR.test(hex)) return "#ffffff";
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  // contrast with white = 1.05 / (lum + 0.05); with ink (~lum 0.011) = (lum + 0.05) / 0.061
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.061 ? "#ffffff" : "#101c3a";
}

/** Field names zod rejected, for aria-invalid on the form. */
export function invalidFields(error: z.ZodError): string[] {
  const out = new Set<string>();
  for (const issue of error.issues) {
    if (typeof issue.path[0] === "string") out.add(issue.path[0]);
  }
  return [...out];
}

// ---------- customers (search + stats) ----------

/** Strips characters that are special inside a PostgREST `or=(...)` filter or an ILIKE pattern. */
export function cleanSearch(raw: string | undefined | null): string {
  return (raw ?? "")
    .replace(/[,()%*_\\"'`;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** PostgREST `or` filter for a search box, or null when it is blank. */
export function customerSearchFilter(raw: string | undefined | null): string | null {
  const q = cleanSearch(raw);
  if (!q) return null;
  const terms = [`full_name.ilike.*${q}*`, `email.ilike.*${q}*`, `phone.ilike.*${q}*`];
  // A local number typed with the leading 0 ("0501234567") is stored as +966501234567.
  if (/^[\d\s+-]+$/.test(q)) {
    const digits = q.replace(/\D/g, "").replace(/^0+/, "");
    if (digits.length >= 3 && digits !== q) terms.push(`phone.ilike.*${digits}*`);
  }
  return terms.join(",");
}

export type CustomerStats = {
  visits: number;
  noShows: number;
  /** ISO instant of the latest completed visit. */
  lastVisit: string | null;
};

/** Visits = completed appointments; last visit = the most recent of them. */
export function summarizeVisits(
  rows: { status: string; starts_at: string }[],
): CustomerStats {
  let visits = 0;
  let noShows = 0;
  let lastVisit: string | null = null;
  for (const r of rows) {
    if (r.status === "completed") {
      visits += 1;
      if (!lastVisit || r.starts_at > lastVisit) lastVisit = r.starts_at;
    } else if (r.status === "no_show") {
      noShows += 1;
    }
  }
  return { visits, noShows, lastVisit };
}
