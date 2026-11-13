"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { createDepositPayment } from "@/lib/payments/booking";
import { getClientIp } from "@/lib/db/client-ip";
import { PHONE_BOOKING_LIMIT, phoneBookingKey } from "@/lib/security/phone-limit";
import { sendBookingEmail } from "@/lib/customer/emails";
import { ensureDemoSessionHash } from "@/lib/demo/session";
import {
  attachDemoSession,
  createBooking,
  getSlots,
  getTenantBySlug,
  rateLimitOk,
  type Slot,
} from "@/lib/db/public";
import {
  bookingInputSchema,
  slotsInputSchema,
  type BookingState,
} from "@/lib/db/schema";

async function clientIp(): Promise<string> {
  return getClientIp(await headers());
}

export type SlotsResult =
  | { ok: true; slots: Slot[] }
  | { ok: false; code: "rate_limited" | "invalid" | "not_found" | "generic" };

/** Available slots for a service (and optional provider) over a date range. */
export async function loadSlots(input: unknown): Promise<SlotsResult> {
  const parsed = slotsInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  try {
    const ip = await clientIp();
    if (!(await rateLimitOk(`ip:${ip}:slots`, 60, "10 minutes"))) {
      return { ok: false, code: "rate_limited" };
    }
    const tenant = await getTenantBySlug(parsed.data.slug);
    if (!tenant) return { ok: false, code: "not_found" };
    const slots = await getSlots({
      tenantId: tenant.id,
      serviceId: parsed.data.serviceId,
      providerId: parsed.data.providerId,
      dateFrom: parsed.data.dateFrom,
      dateTo: parsed.data.dateTo,
    });
    return { ok: true, slots };
  } catch (e) {
    console.error("load_slots_error", e instanceof Error ? e.message : e);
    return { ok: false, code: "generic" };
  }
}

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

/** Form action: validates, rate limits per IP, books, and returns the state to render. */
export async function submitBooking(
  _prev: BookingState,
  formData: FormData,
): Promise<BookingState> {
  const parsed = bookingInputSchema.safeParse({
    slug: str(formData, "slug"),
    locale: str(formData, "locale") || "ar",
    serviceId: str(formData, "serviceId"),
    providerId: str(formData, "providerId"),
    startsAt: str(formData, "startsAt"),
    fullName: str(formData, "fullName"),
    phone: str(formData, "phone"),
    email: str(formData, "email"),
  });

  if (!parsed.success) {
    console.warn(
      "booking_invalid_input",
      parsed.error.issues.map((i) => `${i.path.join(".")}:${i.code}`).join(","),
    );
    const fieldErrors: Extract<BookingState, { status: "error" }>["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path[0];
      if (k === "fullName" || k === "phone" || k === "email") {
        fieldErrors[k] = issue.message === "invalid_phone" ? "phone" : k;
      }
    }
    return { status: "error", code: "invalid", fieldErrors };
  }

  let payPath: string | null = null;
  let manageToken: string | null = null;
  let bookedId = "";
  let success: BookingState = { status: "idle" };
  try {
    const ip = await clientIp();
    if (!(await rateLimitOk(`ip:${ip}:booking`, 10, "10 minutes"))) {
      return { status: "error", code: "rate_limited" };
    }
    const tenant = await getTenantBySlug(parsed.data.slug);
    if (!tenant) return { status: "error", code: "not_found" };
    // L4: per-phone daily cap (hashed key), before anything is created
    if (!(await rateLimitOk(phoneBookingKey(tenant.id, parsed.data.phone), PHONE_BOOKING_LIMIT.max, PHONE_BOOKING_LIMIT.window))) {
      return { status: "error", code: "phone_limit" };
    }
    const result = await createBooking(tenant.id, parsed.data);
    if (!result.ok) return { status: "error", code: result.code };
    success = { status: "success", booking: result.booking };

    // Demo tenant: the visitor's reminders and mails go to their own demo mailbox (cookie session).
    let sessionHash: string | null = null;
    if (tenant.is_demo) {
      try {
        sessionHash = await ensureDemoSessionHash();
        await attachDemoSession(tenant.id, result.booking.appointmentId, sessionHash);
      } catch (e) {
        console.error("demo_session_error", e instanceof Error ? e.message : "unknown");
      }
    }
    // Brand-new customer (the only case where the database hands out a token): keep it on the server.
    // It goes into the booking e-mail and into the redirect below, never into the action's result.
    manageToken = result.customerToken ?? null;
    bookedId = result.booking.appointmentId;
    if (manageToken && parsed.data.email) {
      const mailArgs = {
        tenant,
        token: manageToken,
        appointmentId: result.booking.appointmentId,
        email: parsed.data.email,
        locale: parsed.data.locale,
        sessionHash,
      };
      after(async () => {
        try {
          await sendBookingEmail(mailArgs);
        } catch (e) {
          console.error("booking_email_error", e instanceof Error ? e.message : "unknown");
        }
      });
    }

    // Deposit tenant: the booking is a 15-minute hold. Create the payment and send the customer
    // to the (unguessable) payment page. If that fails the hold stays and the confirmation card
    // tells the customer the business will follow up.
    if (result.booking.status === "pending_payment") {
      try {
        // the fake provider is refused here for any tenant that is not a demo (providerForTenant)
        const created = await createDepositPayment({
          tenant,
          appointmentId: result.booking.appointmentId,
          price: result.booking.price,
          currency: result.booking.currency,
          locale: parsed.data.locale,
        });
        payPath = created?.path ?? null;
      } catch (e) {
        console.error("payment_create_error", e instanceof Error ? e.message : "unknown");
      }
    }
  } catch (e) {
    console.error("booking_error", e instanceof Error ? e.message : e);
    return { status: "error", code: "generic" };
  }
  if (payPath) redirect(payPath); // outside try/catch: redirect() works by throwing
  // New customer without a payment step: land on their own page (it shows the confirmation + the link).
  if (manageToken) redirect(`/${parsed.data.locale}/c/${parsed.data.slug}/my/${manageToken}?booked=${bookedId}`);
  return success;
}
