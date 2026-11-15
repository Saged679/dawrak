import "server-only";
import { getServiceClient } from "./client";
import {
  mapBookingError,
  type BookingErrorCode,
  type BookingInput,
  type BookingResult,
} from "./schema";

export type PublicTenant = {
  id: string;
  slug: string;
  name_ar: string;
  name_en: string | null;
  kind: "clinic" | "salon";
  timezone: string;
  currency: string;
  deposit_enabled: boolean;
  deposit_type: "fixed" | "percent" | null;
  deposit_value: number | null;
  is_demo: boolean;
  brand_color?: string | null;
};

export type PublicService = {
  id: string;
  name_ar: string;
  name_en: string | null;
  description_ar: string | null;
  description_en: string | null;
  duration_min: number;
  price: number;
};

export type PublicProvider = {
  id: string;
  name_ar: string;
  name_en: string | null;
  title_ar: string | null;
  title_en: string | null;
};

export type Slot = { providerId: string; start: string; end: string };

export type HoursRow = { weekday: number; start: string; end: string };

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function getTenantBySlug(slug: string): Promise<PublicTenant | null> {
  if (slug.length > 60 || !SLUG_RE.test(slug)) return null;
  const { data, error } = await getServiceClient().rpc("public_get_tenant", { p_slug: slug });
  if (error) throw error;
  const row = (data as PublicTenant[] | null)?.[0];
  return row ?? null;
}

export async function listServices(tenantId: string): Promise<PublicService[]> {
  const { data, error } = await getServiceClient().rpc("public_list_services", {
    p_tenant_id: tenantId,
  });
  if (error) throw error;
  return ((data as PublicService[] | null) ?? []).map((s) => ({
    ...s,
    price: Number(s.price),
  }));
}

export async function listProviders(
  tenantId: string,
  serviceId: string,
): Promise<PublicProvider[]> {
  const { data, error } = await getServiceClient().rpc("public_list_providers", {
    p_tenant_id: tenantId,
    p_service_id: serviceId,
  });
  if (error) throw error;
  return (data as PublicProvider[] | null) ?? [];
}

export async function listProvidersByService(
  tenantId: string,
  services: PublicService[],
): Promise<Record<string, PublicProvider[]>> {
  const entries = await Promise.all(
    services.map(async (s) => [s.id, await listProviders(tenantId, s.id)] as const),
  );
  return Object.fromEntries(entries);
}

/** Opening hours per weekday (0 = Sunday), merged across providers (earliest open, latest close). */
export async function getOpeningHours(tenantId: string): Promise<HoursRow[]> {
  const { data, error } = await getServiceClient()
    .from("working_hours")
    .select("weekday, start_time, end_time")
    .eq("tenant_id", tenantId);
  if (error) throw error;
  const byDay = new Map<number, { start: string; end: string }>();
  for (const r of (data ?? []) as {
    weekday: number;
    start_time: string;
    end_time: string;
  }[]) {
    const start = r.start_time.slice(0, 5);
    const end = r.end_time.slice(0, 5);
    const cur = byDay.get(r.weekday);
    byDay.set(r.weekday, {
      start: cur && cur.start < start ? cur.start : start,
      end: cur && cur.end > end ? cur.end : end,
    });
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weekday, v]) => ({ weekday, ...v }));
}

/** Returns true while the caller is inside the limit. Fails closed (throws) if the DB call fails. */
export async function rateLimitOk(
  key: string,
  max: number,
  window: string,
): Promise<boolean> {
  const { data, error } = await getServiceClient().rpc("check_rate_limit", {
    p_key: key,
    p_max: max,
    p_window: window,
  });
  if (error) throw error;
  return data === true;
}

export async function getSlots(args: {
  tenantId: string;
  serviceId: string;
  providerId: string | null;
  dateFrom: string;
  dateTo: string;
}): Promise<Slot[]> {
  const { data, error } = await getServiceClient().rpc("get_available_slots", {
    p_tenant_id: args.tenantId,
    p_provider_id: args.providerId,
    p_service_id: args.serviceId,
    p_date_from: args.dateFrom,
    p_date_to: args.dateTo,
    p_step_min: 30,
  });
  if (error) throw error;
  return (
    (data as
      | { slot_provider_id: string; slot_start: string; slot_end: string }[]
      | null) ?? []
  ).map((r) => ({
    providerId: r.slot_provider_id,
    start: r.slot_start,
    end: r.slot_end,
  }));
}

export async function createBooking(
  tenantId: string,
  input: BookingInput,
  /** Demo tenants: SHA-256 of the visitor's session cookie = owner of the new customer and appointment. */
  sessionHash: string | null = null,
): Promise<
  | { ok: true; booking: BookingResult; customerToken: string | null }
  | { ok: false; code: BookingErrorCode }
> {
  const { data, error } = await getServiceClient().rpc("create_public_booking", {
    p_tenant_id: tenantId,
    p_provider_id: input.providerId,
    p_service_id: input.serviceId,
    p_starts_at: input.startsAt,
    p_full_name: input.fullName,
    p_phone: input.phone,
    p_email: input.email ?? null,
    p_source: "web",
    p_locale: input.locale,
    p_session_hash: sessionHash,
  });
  if (error) return { ok: false, code: mapBookingError(error) };
  const d = data as Record<string, unknown>;
  return {
    ok: true,
    booking: {
      appointmentId: String(d.appointment_id),
      status: d.status === "pending_payment" ? "pending_payment" : "confirmed",
      startsAt: String(d.starts_at),
      endsAt: String(d.ends_at),
      price: Number(d.price),
      depositAmount: Number(d.deposit_amount ?? 0),
      currency: String(d.currency),
    },
    // Server-side only: non-null for a brand-new customer. NEVER put it in an action result.
    customerToken: typeof d.customer_token === "string" ? d.customer_token : null,
  };
}

/** Binds a demo appointment to the visitor's demo session (their reminders go to their mailbox). */
export async function attachDemoSession(
  tenantId: string,
  appointmentId: string,
  sessionHash: string,
): Promise<void> {
  const { error } = await getServiceClient().rpc("demo_attach_session", {
    p_tenant_id: tenantId,
    p_appointment_id: appointmentId,
    p_session_hash: sessionHash,
  });
  if (error) throw error;
}
