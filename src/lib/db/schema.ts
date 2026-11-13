import { z } from "zod";

/** Pure helpers shared by the server action, the form and the tests (no server-only import). */

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXT_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

export function normalizeDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(EXT_ARABIC_INDIC.indexOf(d)));
}

/**
 * Accepts Saudi mobiles (05XXXXXXXX, 5XXXXXXXX, +9665XXXXXXXX, 009665...) and Egyptian mobiles
 * (01[0125]XXXXXXXX, 1[0125]XXXXXXXX, +201[0125]XXXXXXXX). Returns E.164 or null.
 */
export function normalizePhone(input: string): string | null {
  let s = normalizeDigits(input).replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  const digits = s.startsWith("+") ? s.slice(1) : s;
  if (!/^\d+$/.test(digits)) return null;

  if (s.startsWith("+")) {
    if (/^9665\d{8}$/.test(digits)) return `+${digits}`;
    if (/^201[0125]\d{8}$/.test(digits)) return `+${digits}`;
    return null;
  }
  if (/^05\d{8}$/.test(digits)) return `+966${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) return `+966${digits}`;
  if (/^9665\d{8}$/.test(digits)) return `+${digits}`;
  if (/^01[0125]\d{8}$/.test(digits)) return `+20${digits.slice(1)}`;
  if (/^1[0125]\d{8}$/.test(digits)) return `+20${digits}`;
  if (/^201[0125]\d{8}$/.test(digits)) return `+${digits}`;
  return null;
}

const slugSchema = z
  .string()
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const bookingInputSchema = z.object({
  slug: slugSchema,
  locale: z.enum(["ar", "en"]).default("ar"),
  serviceId: z.uuid(),
  providerId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  fullName: z.string().trim().min(2).max(100),
  phone: z
    .string()
    .trim()
    .max(30)
    .transform((v, ctx) => {
      const n = normalizePhone(v);
      if (!n) {
        ctx.addIssue({ code: "custom", message: "invalid_phone" });
        return z.NEVER;
      }
      return n;
    }),
  email: z
    .string()
    .trim()
    .max(200)
    .transform((v) => (v === "" ? undefined : v))
    .pipe(z.email().optional()),
});

export type BookingInput = z.infer<typeof bookingInputSchema>;

export const slotsInputSchema = z.object({
  slug: slugSchema,
  serviceId: z.uuid(),
  providerId: z.uuid().nullable(),
  /** YYYY-MM-DD in the tenant timezone */
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type BookingErrorCode =
  | "slot_taken"
  | "too_far"
  | "too_many_bookings"
  | "phone_limit"
  | "rate_limited"
  | "try_again"
  | "invalid"
  | "not_found"
  | "generic";

export type BookingResult = {
  appointmentId: string;
  status: "confirmed" | "pending_payment";
  startsAt: string;
  endsAt: string;
  price: number;
  depositAmount: number;
  currency: string;
};

export type BookingState =
  | { status: "idle" }
  | { status: "success"; booking: BookingResult }
  | {
      status: "error";
      code: BookingErrorCode;
      fieldErrors?: Partial<Record<"fullName" | "phone" | "email", string>>;
    };

/** Maps a Postgres/PostgREST error from create_public_booking to a UI error code. */
export function mapBookingError(
  err: { code?: string; message?: string } | null,
): BookingErrorCode {
  const msg = err?.message ?? "";
  if (err?.code === "23P01" || msg.includes("slot_taken")) return "slot_taken";
  // deadlock_detected / serialization_failure: transient, the same request will normally succeed
  if (err?.code === "40P01" || err?.code === "40001") return "try_again";
  if (msg.includes("too_far")) return "too_far";
  if (msg.includes("too_many_bookings")) return "too_many_bookings";
  if (/invalid_(name|phone|email|source)/.test(msg)) return "invalid";
  if (/(service|provider|tenant)_not_found/.test(msg)) return "not_found";
  return "generic";
}
