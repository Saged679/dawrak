"use server";

import { z } from "zod";
import { allowedStatusTargets, canReschedule, STATUSES } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { mapStaffError, type StaffErrorCode } from "@/lib/dashboard/errors";

export type ActionResult = { ok: true } | { ok: false; code: StaffErrorCode };

export type SlotOption = { providerId: string; start: string; end: string };
export type ProviderOption = { id: string; name_ar: string; name_en: string | null };
export type RescheduleOptions =
  | { ok: true; slots: SlotOption[]; providers: ProviderOption[] }
  | { ok: false; code: StaffErrorCode };

const idSchema = z.uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const statusInput = z.object({ appointmentId: idSchema, status: z.enum(STATUSES) });

/**
 * Status change. The tenant and role come from the session, never from the request. Staff go
 * through staff_update_appointment (it re-checks the slot when reviving a cancelled booking);
 * providers update their own rows directly and RLS limits them to completed / no_show.
 */
export async function setAppointmentStatus(input: unknown): Promise<ActionResult> {
  const parsed = statusInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const session = await getSession();
  if (!session) return { ok: false, code: "forbidden" };

  try {
    const supabase = await createSupabaseServerClient();
    const { data: current, error: readErr } = await supabase
      .from("appointments")
      .select("status")
      .eq("id", parsed.data.appointmentId)
      .eq("tenant_id", session.tenant.id)
      .maybeSingle();
    if (readErr) return { ok: false, code: mapStaffError(readErr) };
    if (!current) return { ok: false, code: "not_found" };
    const allowed = allowedStatusTargets(
      session.role,
      (current as { status: (typeof STATUSES)[number] }).status,
    );
    if (!allowed.includes(parsed.data.status)) return { ok: false, code: "forbidden" };

    if (session.role === "provider") {
      const { data, error } = await supabase
        .from("appointments")
        .update({ status: parsed.data.status })
        .eq("id", parsed.data.appointmentId)
        .eq("tenant_id", session.tenant.id)
        .select("id");
      if (error) return { ok: false, code: mapStaffError(error) };
      if (!data || data.length === 0) return { ok: false, code: "forbidden" };
      return { ok: true };
    }

    const { error } = await supabase.rpc("staff_update_appointment", {
      p_appointment_id: parsed.data.appointmentId,
      p_starts_at: null,
      p_provider_id: null,
      p_service_id: null,
      p_status: parsed.data.status,
      p_notes: null,
    });
    if (error) return { ok: false, code: mapStaffError(error) };
    return { ok: true };
  } catch (e) {
    console.error("set_status_error", e instanceof Error ? e.message : e);
    return { ok: false, code: "generic" };
  }
}

const optionsInput = z.object({
  appointmentId: idSchema,
  providerId: idSchema,
  date: dateSchema,
});

/** Free times for the appointment's service on one day (owner / receptionist only). */
export async function loadRescheduleOptions(input: unknown): Promise<RescheduleOptions> {
  const parsed = optionsInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const session = await getSession();
  if (!session || !canReschedule(session.role)) return { ok: false, code: "forbidden" };

  try {
    const supabase = await createSupabaseServerClient();
    const { data: appt, error: apptErr } = await supabase
      .from("appointments")
      .select("service_id")
      .eq("id", parsed.data.appointmentId)
      .eq("tenant_id", session.tenant.id)
      .maybeSingle();
    if (apptErr) return { ok: false, code: mapStaffError(apptErr) };
    if (!appt) return { ok: false, code: "not_found" };
    const serviceId = (appt as { service_id: string }).service_id;

    const { data: links, error: linkErr } = await supabase
      .from("provider_services")
      .select("provider_id")
      .eq("tenant_id", session.tenant.id)
      .eq("service_id", serviceId);
    if (linkErr) return { ok: false, code: mapStaffError(linkErr) };
    const providerIds = ((links ?? []) as { provider_id: string }[]).map((l) => l.provider_id);

    const { data: provs, error: provErr } = await supabase
      .from("providers")
      .select("id, name_ar, name_en")
      .eq("tenant_id", session.tenant.id)
      .eq("is_active", true)
      .in("id", providerIds)
      .order("created_at", { ascending: true });
    if (provErr) return { ok: false, code: mapStaffError(provErr) };
    const providers = (provs ?? []) as ProviderOption[];
    if (!providers.some((p) => p.id === parsed.data.providerId)) {
      return { ok: false, code: "invalid" };
    }

    const { data, error } = await supabase.rpc("staff_get_available_slots", {
      p_tenant_id: session.tenant.id,
      p_provider_id: parsed.data.providerId,
      p_service_id: serviceId,
      p_date_from: parsed.data.date,
      p_date_to: parsed.data.date,
      p_step_min: 15,
    });
    if (error) return { ok: false, code: mapStaffError(error) };
    const slots = (
      (data ?? []) as { slot_provider_id: string; slot_start: string; slot_end: string }[]
    ).map((r) => ({ providerId: r.slot_provider_id, start: r.slot_start, end: r.slot_end }));
    return { ok: true, slots, providers };
  } catch (e) {
    console.error("reschedule_options_error", e instanceof Error ? e.message : e);
    return { ok: false, code: "generic" };
  }
}

const moveInput = z.object({
  appointmentId: idSchema,
  providerId: idSchema,
  startsAt: z.iso.datetime({ offset: true }),
});

export async function rescheduleAppointment(input: unknown): Promise<ActionResult> {
  const parsed = moveInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const session = await getSession();
  if (!session || !canReschedule(session.role)) return { ok: false, code: "forbidden" };

  try {
    const supabase = await createSupabaseServerClient();
    // The function checks membership itself; this read keeps another tenant's id from ever
    // reaching it from a manipulated request.
    const { data: own } = await supabase
      .from("appointments")
      .select("id")
      .eq("id", parsed.data.appointmentId)
      .eq("tenant_id", session.tenant.id)
      .maybeSingle();
    if (!own) return { ok: false, code: "not_found" };

    const { error } = await supabase.rpc("staff_update_appointment", {
      p_appointment_id: parsed.data.appointmentId,
      p_starts_at: parsed.data.startsAt,
      p_provider_id: parsed.data.providerId,
      p_service_id: null,
      p_status: null,
      p_notes: null,
    });
    if (error) return { ok: false, code: mapStaffError(error) };
    return { ok: true };
  } catch (e) {
    console.error("reschedule_error", e instanceof Error ? e.message : e);
    return { ok: false, code: "generic" };
  }
}
