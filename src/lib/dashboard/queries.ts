import "server-only";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { canSeeRevenue, type AppointmentStatus } from "@/lib/auth/roles";
import type { SessionContext } from "@/lib/auth/session";
import { addDays, dayRange, dateKeyInZone, parseTimeToMinutes, weekStartKey, zonedToUtc } from "./time";

type Named = { name_ar: string; name_en: string | null };

export type AppointmentRow = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  price: number;
  notes: string | null;
  providerId: string;
  provider: Named;
  serviceId: string;
  service: Named;
  customer: { full_name: string; phone: string };
};

export type ProviderRow = Named & { id: string; title_ar: string | null; title_en: string | null };

type Customer = { full_name: string; phone: string };

type RawAppointment = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  price: number | string;
  notes: string | null;
  provider_id: string;
  service_id: string;
  providers: Named | Named[] | null;
  services: Named | Named[] | null;
  customers: Customer | Customer[] | null;
};

// Explicit columns only: staff may not `select *` on customers (access_token is not granted).
const APPOINTMENT_SELECT =
  "id, starts_at, ends_at, status, price, notes, provider_id, service_id, " +
  "providers(name_ar, name_en), services(name_ar, name_en), customers(full_name, phone)";

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function mapAppointment(r: RawAppointment): AppointmentRow {
  return {
    id: r.id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    price: Number(r.price),
    notes: r.notes,
    providerId: r.provider_id,
    provider: one(r.providers) ?? { name_ar: "", name_en: null },
    serviceId: r.service_id,
    service: one(r.services) ?? { name_ar: "", name_en: null },
    customer: one(r.customers) ?? { full_name: "", phone: "" },
  };
}

export async function listAppointments(
  session: SessionContext,
  range: { from: string; to: string },
  opts: { providerId?: string | null; limit?: number; statuses?: AppointmentStatus[] } = {},
): Promise<AppointmentRow[]> {
  const supabase = await createSupabaseServerClient();
  let q = supabase
    .from("appointments")
    .select(APPOINTMENT_SELECT)
    .eq("tenant_id", session.tenant.id)
    .gte("starts_at", range.from)
    .lt("starts_at", range.to)
    .order("starts_at", { ascending: true })
    .limit(opts.limit ?? 500);
  if (opts.providerId) q = q.eq("provider_id", opts.providerId);
  if (opts.statuses) q = q.in("status", opts.statuses);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as unknown as RawAppointment[]).map(mapAppointment);
}

async function countAppointments(
  session: SessionContext,
  range: { from: string; to: string },
  statuses: AppointmentStatus[],
): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { count, error } = await supabase
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", session.tenant.id)
    .gte("starts_at", range.from)
    .lt("starts_at", range.to)
    .in("status", statuses);
  if (error) throw error;
  return count ?? 0;
}

export type Overview = {
  todayKey: string;
  today: AppointmentRow[];
  upcoming: AppointmentRow[];
  weekCount: number;
  noShow: { rate: number | null; sample: number };
  /** Present for the owner only; never queried for other roles. */
  revenue: { week: number; month: number } | null;
};

/** Pure: no-show rate over finished appointments (completed + no_show). */
export function noShowRate(completed: number, noShow: number): number | null {
  const total = completed + noShow;
  return total === 0 ? null : noShow / total;
}

export async function loadOverview(session: SessionContext, now = new Date()): Promise<Overview> {
  const tz = session.tenant.timezone;
  const todayKey = dateKeyInZone(now, tz);
  const today = dayRange(todayKey, tz);
  const weekStart = weekStartKey(todayKey);
  const week = { from: dayRange(weekStart, tz).from, to: dayRange(addDays(weekStart, 7), tz).from };
  const last30 = { from: dayRange(addDays(todayKey, -30), tz).from, to: today.to };
  const active: AppointmentStatus[] = ["pending_payment", "confirmed", "completed", "no_show"];

  const [todayRows, upcoming, weekCount, completed, noShow] = await Promise.all([
    listAppointments(session, today, { statuses: active }),
    listAppointments(
      session,
      { from: now.toISOString(), to: dayRange(addDays(todayKey, 30), tz).from },
      { statuses: ["pending_payment", "confirmed"], limit: 6 },
    ),
    countAppointments(session, week, active),
    countAppointments(session, last30, ["completed"]),
    countAppointments(session, last30, ["no_show"]),
  ]);

  let revenue: Overview["revenue"] = null;
  if (canSeeRevenue(session.role)) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("payments")
      .select("amount, created_at")
      .eq("tenant_id", session.tenant.id)
      .eq("status", "paid")
      .gte("created_at", last30.from)
      .limit(2000);
    if (error) throw error;
    let w = 0;
    let m = 0;
    for (const p of (data ?? []) as { amount: number | string; created_at: string }[]) {
      m += Number(p.amount);
      if (p.created_at >= week.from && p.created_at < week.to) w += Number(p.amount);
    }
    revenue = { week: w, month: m };
  }

  return {
    todayKey,
    today: todayRows,
    upcoming,
    weekCount,
    noShow: { rate: noShowRate(completed, noShow), sample: completed + noShow },
    revenue,
  };
}

export async function listProviders(session: SessionContext): Promise<ProviderRow[]> {
  const supabase = await createSupabaseServerClient();
  let q = supabase
    .from("providers")
    .select("id, name_ar, name_en, title_ar, title_en")
    .eq("tenant_id", session.tenant.id)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  // A provider sees only themselves, whatever the URL says.
  if (session.role === "provider") {
    q = q.eq("id", session.providerId ?? "00000000-0000-0000-0000-000000000000");
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as ProviderRow[];
}

/** Opening windows in minutes since midnight, for the calendar grid bounds. */
export async function listWorkingWindows(
  session: SessionContext,
): Promise<{ start: number; end: number }[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("working_hours")
    .select("start_time, end_time")
    .eq("tenant_id", session.tenant.id);
  if (error) throw error;
  return ((data ?? []) as { start_time: string; end_time: string }[]).map((r) => ({
    start: parseTimeToMinutes(r.start_time),
    end: parseTimeToMinutes(r.end_time),
  }));
}

export type RevenueDay = { dateKey: string; total: number; count: number };

export async function loadRevenue(
  session: SessionContext,
  now = new Date(),
): Promise<{ days: RevenueDay[]; total: number; count: number }> {
  if (!canSeeRevenue(session.role)) throw new Error("forbidden");
  const tz = session.tenant.timezone;
  const todayKey = dateKeyInZone(now, tz);
  const from = zonedToUtc(addDays(todayKey, -29), 0, tz).toISOString();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("payments")
    .select("amount, created_at")
    .eq("tenant_id", session.tenant.id)
    .eq("status", "paid")
    .gte("created_at", from)
    .limit(5000);
  if (error) throw error;
  const byDay = new Map<string, RevenueDay>();
  for (let i = 0; i < 30; i++) {
    const k = addDays(todayKey, -i);
    byDay.set(k, { dateKey: k, total: 0, count: 0 });
  }
  let total = 0;
  let count = 0;
  for (const p of (data ?? []) as { amount: number | string; created_at: string }[]) {
    const day = byDay.get(dateKeyInZone(p.created_at, tz));
    if (!day) continue;
    day.total += Number(p.amount);
    day.count += 1;
    total += Number(p.amount);
    count += 1;
  }
  return { days: [...byDay.values()], total, count };
}

export type ReminderCounts = { pending: number; sent: number; failed: number };

/** Pure: tallies reminder statuses (sending counts as pending; cancelled / skipped are not shown). */
export function tallyReminders(statuses: string[]): ReminderCounts {
  const c: ReminderCounts = { pending: 0, sent: 0, failed: 0 };
  for (const s of statuses) {
    if (s === "pending" || s === "sending") c.pending++;
    else if (s === "sent") c.sent++;
    else if (s === "failed") c.failed++;
  }
  return c;
}

/**
 * Reminders scheduled for today (tenant timezone). Owner and receptionist only: any other role gets
 * null and no query is made. RLS and a column-level grant limit what the database returns anyway.
 */
export async function loadReminderCounts(
  session: SessionContext,
  now = new Date(),
): Promise<ReminderCounts | null> {
  if (session.role !== "owner" && session.role !== "receptionist") return null;
  const tz = session.tenant.timezone;
  const today = dayRange(dateKeyInZone(now, tz), tz);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("reminders")
    .select("status")
    .eq("tenant_id", session.tenant.id)
    .gte("send_at", today.from)
    .lt("send_at", today.to)
    .limit(2000);
  if (error) throw error;
  return tallyReminders(((data ?? []) as { status: string }[]).map((r) => r.status));
}
