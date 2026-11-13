import "server-only";
import type { Loc } from "@/components/booking/dates";
import { getServiceClient } from "@/lib/db/client";
import type { PublicTenant } from "@/lib/db/public";
import { mailProviderFor } from "@/lib/mail";
import { MailError, type MailProvider } from "@/lib/mail/types";
import { manageUrl } from "@/lib/mail/links";
import { renderEmail } from "@/lib/mail/templates";
import { loadPortal } from "./portal";

const NO_EMAIL = "no-email-on-file@demo.invalid";
const pick = (loc: Loc, ar: string | null, en: string | null) => (loc === "en" ? en || ar || "" : ar || en || "");

/**
 * "Your booking" mail for a brand-new customer, to the address they typed. Demo tenants write to the
 * visitor's own outbox (sessionHash), everyone else goes through the configured provider.
 */
export async function sendBookingEmail(a: {
  tenant: Pick<PublicTenant, "id" | "slug" | "is_demo">;
  token: string;
  appointmentId: string;
  email: string;
  locale: Loc;
  sessionHash: string | null;
}): Promise<void> {
  const portal = await loadPortal(a.tenant.slug, a.token);
  const appt = portal?.appointments.find((x) => x.id === a.appointmentId);
  if (!portal || !appt) return;
  const mail = renderEmail({
    kind: "booking",
    locale: a.locale,
    customerName: portal.fullName,
    tenantName: pick(a.locale, portal.tenant.name_ar, portal.tenant.name_en),
    serviceName: pick(a.locale, appt.serviceNameAr, appt.serviceNameEn),
    providerName: pick(a.locale, appt.providerNameAr, appt.providerNameEn),
    startsAt: appt.startsAt,
    timezone: portal.tenant.timezone,
    manageUrl: manageUrl(a.locale, a.tenant.slug, a.token),
    awaitingDeposit: appt.status === "pending_payment",
  });
  await mailProviderFor(a.tenant).send({
    to: a.email,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    tenantId: a.tenant.id,
    kind: "booking",
    sessionHash: a.sessionHash,
  });
}

/**
 * "Send me my link": rotates the token of the customer found by phone or e-mail and mails it to the
 * contact ON FILE. Returns silently when nobody matches (the caller shows the same message either way).
 */
export async function sendLinkEmail(a: {
  tenant: Pick<PublicTenant, "id" | "slug" | "is_demo" | "name_ar" | "name_en">;
  phone: string | null;
  email: string | null;
  sessionHash: string | null;
}): Promise<void> {
  // M1: resolve the provider BEFORE touching the customer's link. When nothing can be sent (real tenant
  // without a configured provider) the RPC is never called, so a patient's token is not slid or rotated
  // for a mail that cannot go out.
  let provider: MailProvider;
  try {
    provider = mailProviderFor(a.tenant);
  } catch (e) {
    console.error("link_email_no_provider", e instanceof MailError ? e.code : "unknown");
    return;
  }
  const { data, error } = await getServiceClient().rpc("customer_issue_link", {
    p_tenant_id: a.tenant.id,
    p_phone: a.phone,
    p_email: a.email,
    // H2: in a demo tenant only the visitor session that created the customer gets a link; a real tenant never binds.
    p_session_hash: a.tenant.is_demo ? a.sessionHash : null,
  });
  if (error) throw error;
  const row = (
    data as { link_token: string; contact_email: string | null; contact_name: string; contact_locale: string }[] | null
  )?.[0];
  if (!row) return;
  const to = row.contact_email || (a.tenant.is_demo ? NO_EMAIL : null);
  if (!to) return; // nowhere to send it, and the token is never shown to the requester
  const locale: Loc = row.contact_locale === "en" ? "en" : "ar";
  const mail = renderEmail({
    kind: "link",
    locale,
    customerName: row.contact_name,
    tenantName: pick(locale, a.tenant.name_ar, a.tenant.name_en),
    timezone: "UTC",
    manageUrl: manageUrl(locale, a.tenant.slug, row.link_token),
  });
  await provider.send({
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    tenantId: a.tenant.id,
    kind: "link",
    sessionHash: a.sessionHash,
  });
}
