"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { loadPortal } from "@/lib/customer/portal";
import { sendLinkEmail } from "@/lib/customer/emails";
import { canChange, isCustomerToken, isSafeSlug } from "@/lib/customer/policy";
import { getClientIp } from "@/lib/db/client-ip";
import { getServiceClient } from "@/lib/db/client";
import { getTenantBySlug, rateLimitOk } from "@/lib/db/public";
import { ensureDemoSessionHash } from "@/lib/demo/session";
import { mapBookingError, normalizePhone } from "@/lib/db/schema";

const base = z.object({
  slug: z.string().refine(isSafeSlug),
  locale: z.enum(["ar", "en"]),
});
const tokenForm = base.extend({
  token: z.string().refine(isCustomerToken),
  appointmentId: z.uuid(),
});
const rescheduleForm = tokenForm.extend({ startsAt: z.iso.datetime({ offset: true }) });

const field = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

/** Codes the patient page knows how to word (messages: Portal.errors.*). */
export type PortalError =
  | "slot_taken"
  | "too_far"
  | "too_many_bookings"
  | "try_again"
  | "too_late"
  | "rate_limited"
  | "not_found"
  | "pick_time"
  | "generic";

const pagePath = (locale: string, slug: string, token: string) => `/${locale}/c/${slug}/my/${token}`;

function isNextControl(e: unknown): boolean {
  const d = (e as { digest?: unknown } | null)?.digest;
  return typeof d === "string" && (d.startsWith("NEXT_REDIRECT") || d.startsWith("NEXT_HTTP_ERROR_FALLBACK"));
}

async function limited(kind: string): Promise<boolean> {
  const ip = getClientIp(await headers());
  return !(await rateLimitOk(`ip:${ip}:my-${kind}`, 20, "10 minutes"));
}

/** Cancel (until CANCEL_WINDOW_HOURS before the start). Redirects back to the page with ?done or ?error. */
export async function cancelAppointment(formData: FormData): Promise<void> {
  const p = tokenForm.safeParse(Object.fromEntries(["slug", "locale", "token", "appointmentId"].map((k) => [k, field(formData, k)])));
  if (!p.success) notFound();
  const { slug, locale, token, appointmentId } = p.data;
  const page = pagePath(locale, slug, token);

  let target: string;
  try {
    if (await limited("write")) {
      target = `${page}?error=rate_limited`;
    } else {
      const portal = await loadPortal(slug, token);
      if (!portal) notFound();
      const appt = portal.appointments.find((a) => a.id === appointmentId);
      if (!appt) {
        target = `${page}?error=not_found`;
      } else if (!canChange(appt.status, appt.startsAt)) {
        target = `${page}?error=too_late`;
      } else {
        const { data, error } = await getServiceClient().rpc("customer_cancel_appointment", {
          p_token: token,
          p_appointment_id: appointmentId,
        });
        if (error) throw error;
        target = data === true ? `${page}?done=cancelled` : `${page}?error=not_found`;
      }
    }
  } catch (e) {
    if (isNextControl(e)) throw e;
    console.error("portal_cancel_error", e instanceof Error ? e.message : "unknown");
    target = `${page}?error=generic`;
  }
  redirect(target);
}

/** Move to a new start time (the slot is re-validated by customer_reschedule_appointment). */
export async function rescheduleAppointment(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(["slug", "locale", "token", "appointmentId", "startsAt"].map((k) => [k, field(formData, k)]));
  const p = rescheduleForm.safeParse(raw);
  if (!p.success) {
    // a missing time is a user mistake, not a probe: send them back to the picker
    const t = tokenForm.safeParse(raw);
    if (!t.success) notFound();
    redirect(`${pagePath(t.data.locale, t.data.slug, t.data.token)}?reschedule=${t.data.appointmentId}&error=pick_time`);
  }
  const { slug, locale, token, appointmentId, startsAt } = p.data;
  const page = pagePath(locale, slug, token);

  let target: string;
  try {
    if (await limited("write")) {
      target = `${page}?error=rate_limited`;
    } else {
      const portal = await loadPortal(slug, token);
      if (!portal) notFound();
      const appt = portal.appointments.find((a) => a.id === appointmentId);
      if (!appt) {
        target = `${page}?error=not_found`;
      } else if (!canChange(appt.status, appt.startsAt)) {
        target = `${page}?error=too_late`;
      } else {
        const { error } = await getServiceClient().rpc("customer_reschedule_appointment", {
          p_token: token,
          p_appointment_id: appointmentId,
          p_new_starts_at: startsAt,
        });
        if (error) {
          const code: PortalError = /appointment_not_found/.test(error.message ?? "")
            ? "not_found"
            : (mapBookingError(error) as PortalError);
          target = `${page}?reschedule=${appointmentId}&error=${code}`;
        } else {
          target = `${page}?done=rescheduled`;
        }
      }
    }
  } catch (e) {
    if (isNextControl(e)) throw e;
    console.error("portal_reschedule_error", e instanceof Error ? e.message : "unknown");
    target = `${page}?error=generic`;
  }
  redirect(target);
}

const requestForm = base.extend({ contact: z.string().trim().min(3).max(200) });
const sha = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 32);

/**
 * "Send me my link". The answer (redirect to ?sent=1) is the same whether or not a customer exists:
 * the lookup and the mail run after the response (after()), and a demo visitor always gets a session
 * cookie. Rate limited per IP and per contact (hashed). The token only ever travels by e-mail.
 */
export async function requestLink(formData: FormData): Promise<void> {
  const p = requestForm.safeParse({
    slug: field(formData, "slug"),
    locale: field(formData, "locale"),
    contact: field(formData, "contact"),
  });
  if (!p.success) {
    const b = base.safeParse({ slug: field(formData, "slug"), locale: field(formData, "locale") });
    if (!b.success) notFound();
    redirect(`/${b.data.locale}/c/${b.data.slug}/my?error=invalid`);
  }
  const { slug, locale } = p.data;
  const contact = p.data.contact;
  const isEmail = contact.includes("@");
  const email = isEmail ? z.email().safeParse(contact).data?.toLowerCase() : undefined;
  const phone = isEmail ? undefined : (normalizePhone(contact) ?? undefined);
  if (!email && !phone) redirect(`/${locale}/c/${slug}/my?error=invalid`);

  let target = `/${locale}/c/${slug}/my?sent=1`;
  try {
    const tenant = await getTenantBySlug(slug);
    if (!tenant) notFound();
    const ip = getClientIp(await headers());
    const ipOk = await rateLimitOk(`ip:${ip}:mylink`, 8, "10 minutes");
    const contactOk = await rateLimitOk(`contact:${sha(`${tenant.id}|${email ?? phone}`)}:mylink`, 3, "1 hour");
    if (!ipOk || !contactOk) {
      target = `/${locale}/c/${slug}/my?error=rate_limited`;
    } else {
      const sessionHash = tenant.is_demo ? await ensureDemoSessionHash() : null;
      after(async () => {
        try {
          await sendLinkEmail({ tenant, phone: phone ?? null, email: email ?? null, sessionHash });
        } catch (e) {
          console.error("link_email_error", e instanceof Error ? e.message : "unknown");
        }
      });
    }
  } catch (e) {
    if (isNextControl(e)) throw e;
    console.error("request_link_error", e instanceof Error ? e.message : "unknown");
    target = `/${locale}/c/${slug}/my?error=generic`;
  }
  redirect(target);
}
