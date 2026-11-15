import "server-only";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import type { AppointmentStatus } from "@/lib/auth/roles";
import type { SessionContext } from "@/lib/auth/session";
import { isCatalogLockedInDemo } from "./demo-lock";
import {
  customerSearchFilter,
  summarizeVisits,
  trimSeconds,
  type CustomerStats,
} from "./manage";

type Named = { name_ar: string; name_en: string | null };

/** A provider who has no linked login row sees nothing (never "all rows"). */
const NO_ROW = "00000000-0000-0000-0000-000000000000";

// ---------- services ----------

export type ServiceRow = {
  id: string;
  name_ar: string;
  name_en: string;
  description_ar: string | null;
  description_en: string | null;
  duration_min: number;
  buffer_min: number;
  price: number;
  is_active: boolean;
  providerIds: string[];
  /** demo business and not created by this visitor: the database refuses edits */
  locked: boolean;
};

const SERVICE_COLUMNS =
  "id, name_ar, name_en, description_ar, description_en, duration_min, buffer_min, price, is_active, created_by";

type RawService = Omit<ServiceRow, "providerIds" | "price" | "locked"> & { price: number | string; created_by: string | null };

async function linksFor(
  session: SessionContext,
  by: { serviceIds?: string[]; providerIds?: string[] },
): Promise<{ provider_id: string; service_id: string }[]> {
  const supabase = await createSupabaseServerClient();
  let q = supabase
    .from("provider_services")
    .select("provider_id, service_id")
    .eq("tenant_id", session.tenant.id);
  if (by.serviceIds) q = q.in("service_id", by.serviceIds);
  if (by.providerIds) q = q.in("provider_id", by.providerIds);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as { provider_id: string; service_id: string }[];
}

export async function listServices(session: SessionContext): Promise<ServiceRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("services")
    .select(SERVICE_COLUMNS)
    .eq("tenant_id", session.tenant.id)
    .order("is_active", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as unknown as RawService[];
  const links = rows.length ? await linksFor(session, {}) : [];
  return rows.map((r) => ({
    ...r,
    locked: isCatalogLockedInDemo(session),
    price: Number(r.price),
    providerIds: links.filter((l) => l.service_id === r.id).map((l) => l.provider_id),
  }));
}

export async function getService(session: SessionContext, id: string): Promise<ServiceRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("services")
    .select(SERVICE_COLUMNS)
    .eq("tenant_id", session.tenant.id)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as RawService;
  const links = await linksFor(session, { serviceIds: [id] });
  return { ...row, locked: isCatalogLockedInDemo(session), price: Number(row.price), providerIds: links.map((l) => l.provider_id) };
}

// ---------- providers ----------

export type ProviderFull = Named & {
  id: string;
  title_ar: string | null;
  title_en: string | null;
  bio_ar: string | null;
  bio_en: string | null;
  is_active: boolean;
  name_en: string;
  locked: boolean;
};

const PROVIDER_COLUMNS = "id, name_ar, name_en, title_ar, title_en, bio_ar, bio_en, is_active, created_by";

/** Active and inactive providers. A provider-role user only ever gets their own row. */
export async function listManagedProviders(session: SessionContext): Promise<ProviderFull[]> {
  const supabase = await createSupabaseServerClient();
  let q = supabase
    .from("providers")
    .select(PROVIDER_COLUMNS)
    .eq("tenant_id", session.tenant.id)
    .order("is_active", { ascending: false })
    .order("created_at", { ascending: true });
  if (session.role === "provider") q = q.eq("id", session.providerId ?? NO_ROW);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as unknown as (Omit<ProviderFull, "locked"> & { created_by: string | null })[]).map((r) => ({
    ...r,
    locked: isCatalogLockedInDemo(session),
  }));
}

export async function getManagedProvider(
  session: SessionContext,
  id: string,
): Promise<ProviderFull | null> {
  if (session.role === "provider" && id !== session.providerId) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("providers")
    .select(PROVIDER_COLUMNS)
    .eq("tenant_id", session.tenant.id)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as unknown as Omit<ProviderFull, "locked"> & { created_by: string | null };
  return { ...r, locked: isCatalogLockedInDemo(session) };
}

export type WorkingHourRow = { weekday: number; start: string; end: string; locked: boolean };

export async function listProviderHours(
  session: SessionContext,
  providerId: string,
): Promise<WorkingHourRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("working_hours")
    .select("weekday, start_time, end_time, created_by")
    .eq("tenant_id", session.tenant.id)
    .eq("provider_id", providerId)
    .order("weekday", { ascending: true })
    .order("start_time", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as { weekday: number; start_time: string; end_time: string; created_by: string | null }[]).map((r) => ({
    weekday: r.weekday,
    start: trimSeconds(r.start_time),
    end: trimSeconds(r.end_time),
    locked: isCatalogLockedInDemo(session),
  }));
}

export type TimeOffRow = { id: string; startsAt: string; endsAt: string; reason: string | null; locked: boolean };

/** Current and future time off (past blocks are history, not shown). */
export async function listProviderTimeOff(
  session: SessionContext,
  providerId: string,
  now = new Date(),
): Promise<TimeOffRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("time_off")
    .select("id, starts_at, ends_at, reason, created_by")
    .eq("tenant_id", session.tenant.id)
    .eq("provider_id", providerId)
    .gte("ends_at", now.toISOString())
    .order("starts_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  return ((data ?? []) as { id: string; starts_at: string; ends_at: string; reason: string | null; created_by: string | null }[]).map(
    (r) => ({ id: r.id, startsAt: r.starts_at, endsAt: r.ends_at, reason: r.reason, locked: isCatalogLockedInDemo(session) }),
  );
}

/** Services a provider performs (names for display). */
export async function listProviderServices(
  session: SessionContext,
  providerId: string,
): Promise<(Named & { id: string; is_active: boolean })[]> {
  const links = await linksFor(session, { providerIds: [providerId] });
  if (links.length === 0) return [];
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("services")
    .select("id, name_ar, name_en, is_active")
    .eq("tenant_id", session.tenant.id)
    .in(
      "id",
      links.map((l) => l.service_id),
    )
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as (Named & { id: string; is_active: boolean })[];
}

// ---------- customers ----------

// Explicit columns only. staff have column-level SELECT on customers WITHOUT access_token, so a
// `select *` would fail, and the token must never reach the app anyway.
const CUSTOMER_COLUMNS = "id, full_name, phone, email, locale, created_at";

export type CustomerRow = {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  locale: string;
  created_at: string;
};

export const CUSTOMER_PAGE_SIZE = 50;

export type CustomerListItem = CustomerRow & CustomerStats;

/**
 * Customers matching `q`, with visit stats. RLS limits a provider to customers on their own
 * appointments; the stats query is limited the same way (and filtered to their provider id here,
 * so a provider never sees counts that include other providers' appointments).
 */
export async function listCustomers(
  session: SessionContext,
  q: string | undefined,
): Promise<{ items: CustomerListItem[]; truncated: boolean }> {
  if (session.role === "provider" && !session.providerId) return { items: [], truncated: false };
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .eq("tenant_id", session.tenant.id)
    .order("created_at", { ascending: false })
    .limit(CUSTOMER_PAGE_SIZE + 1);
  const filter = customerSearchFilter(q);
  if (filter) query = query.or(filter);
  const { data, error } = await query;
  if (error) throw error;
  const all = (data ?? []) as unknown as CustomerRow[];
  const truncated = all.length > CUSTOMER_PAGE_SIZE;
  const rows = all.slice(0, CUSTOMER_PAGE_SIZE);
  if (rows.length === 0) return { items: [], truncated };

  let aq = supabase
    .from("appointments")
    .select("customer_id, status, starts_at")
    .eq("tenant_id", session.tenant.id)
    .in(
      "customer_id",
      rows.map((r) => r.id),
    )
    .limit(5000);
  if (session.role === "provider") aq = aq.eq("provider_id", session.providerId!);
  const { data: appts, error: aerr } = await aq;
  if (aerr) throw aerr;
  const byCustomer = new Map<string, { status: string; starts_at: string }[]>();
  for (const a of (appts ?? []) as { customer_id: string; status: string; starts_at: string }[]) {
    const list = byCustomer.get(a.customer_id) ?? [];
    list.push(a);
    byCustomer.set(a.customer_id, list);
  }
  return {
    items: rows.map((r) => ({ ...r, ...summarizeVisits(byCustomer.get(r.id) ?? []) })),
    truncated,
  };
}

export type CustomerHistoryItem = {
  id: string;
  startsAt: string;
  status: AppointmentStatus;
  price: number;
  service: Named;
  provider: Named;
};

type RawHistory = {
  id: string;
  starts_at: string;
  status: AppointmentStatus;
  price: number | string;
  services: Named | Named[] | null;
  providers: Named | Named[] | null;
};

const one = <T>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export async function getCustomerDetail(
  session: SessionContext,
  id: string,
): Promise<{ customer: CustomerRow; history: CustomerHistoryItem[]; stats: CustomerStats } | null> {
  if (session.role === "provider" && !session.providerId) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .eq("tenant_id", session.tenant.id)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null; // RLS hides a provider's non-customers: same answer as "does not exist"

  let aq = supabase
    .from("appointments")
    .select("id, starts_at, status, price, services(name_ar, name_en), providers(name_ar, name_en)")
    .eq("tenant_id", session.tenant.id)
    .eq("customer_id", id)
    .order("starts_at", { ascending: false })
    .limit(200);
  if (session.role === "provider") aq = aq.eq("provider_id", session.providerId!);
  const { data: appts, error: aerr } = await aq;
  if (aerr) throw aerr;
  const raw = (appts ?? []) as unknown as RawHistory[];
  const history = raw.map((r) => ({
    id: r.id,
    startsAt: r.starts_at,
    status: r.status,
    price: Number(r.price),
    service: one(r.services) ?? { name_ar: "", name_en: null },
    provider: one(r.providers) ?? { name_ar: "", name_en: null },
  }));
  // A provider with no appointment history for this customer is not their customer.
  if (session.role === "provider" && history.length === 0) return null;
  return {
    customer: data as unknown as CustomerRow,
    history,
    stats: summarizeVisits(raw),
  };
}
