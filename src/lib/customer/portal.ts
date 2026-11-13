import "server-only";
import { getServiceClient } from "@/lib/db/client";
import { getSlots, getTenantBySlug, type PublicTenant, type Slot } from "@/lib/db/public";
import { isCustomerToken, isSafeSlug } from "./policy";

export type PortalAppointment = {
  id: string;
  providerId: string;
  serviceId: string;
  providerNameAr: string;
  providerNameEn: string | null;
  serviceNameAr: string;
  serviceNameEn: string | null;
  startsAt: string;
  endsAt: string;
  status: "pending_payment" | "confirmed" | "cancelled" | "completed" | "no_show";
  price: number;
  currency: string;
  depositStatus: string | null;
  depositAmount: number | null;
  paymentExpiresAt: string | null;
};

export type Portal = {
  tenant: PublicTenant;
  fullName: string;
  appointments: PortalAppointment[];
};

type CustomerRow = { customer_id: string; tenant_id: string; tenant_slug: string; full_name: string; locale: string };
type ApptRow = {
  id: string;
  provider_id: string;
  service_id: string;
  provider_name_ar: string;
  provider_name_en: string | null;
  service_name_ar: string;
  service_name_en: string | null;
  starts_at: string;
  ends_at: string;
  status: PortalAppointment["status"];
  price: number | string;
  currency: string;
  deposit_status: string | null;
  deposit_amount: number | string | null;
  payment_expires_at: string | null;
};

/**
 * Resolves a patient-page URL. Returns null (=> 404, no hint which part was wrong) when the token is
 * malformed, unknown, expired, or belongs to a different clinic than the slug in the URL.
 */
export async function loadPortal(slug: string, token: string): Promise<Portal | null> {
  if (!isSafeSlug(slug) || !isCustomerToken(token)) return null;
  const db = getServiceClient();
  const { data: cust, error } = await db.rpc("customer_portal_get", { p_token: token });
  if (error) throw error;
  const c = (cust as CustomerRow[] | null)?.[0];
  if (!c || c.tenant_slug !== slug) return null;
  const tenant = await getTenantBySlug(slug);
  if (!tenant || tenant.id !== c.tenant_id) return null;

  const { data, error: ae } = await db.rpc("customer_portal_appointments", { p_token: token });
  if (ae) throw ae;
  const appointments = ((data as ApptRow[] | null) ?? []).map(
    (r): PortalAppointment => ({
      id: r.id,
      providerId: r.provider_id,
      serviceId: r.service_id,
      providerNameAr: r.provider_name_ar,
      providerNameEn: r.provider_name_en,
      serviceNameAr: r.service_name_ar,
      serviceNameEn: r.service_name_en,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      status: r.status,
      price: Number(r.price),
      currency: r.currency,
      depositStatus: r.deposit_status,
      depositAmount: r.deposit_amount === null ? null : Number(r.deposit_amount),
      paymentExpiresAt: r.payment_expires_at,
    }),
  );
  return { tenant, fullName: c.full_name, appointments };
}

/** Free slots for moving one appointment (same provider and service), next `days` days from today. */
export async function loadRescheduleSlots(
  portal: Portal,
  appointment: PortalAppointment,
  dateFrom: string,
  dateTo: string,
): Promise<Slot[]> {
  return getSlots({
    tenantId: portal.tenant.id,
    serviceId: appointment.serviceId,
    providerId: appointment.providerId,
    dateFrom,
    dateTo,
  });
}
