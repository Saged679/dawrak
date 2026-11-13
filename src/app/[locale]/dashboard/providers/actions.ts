"use server";

import { z } from "zod";
import { canManageCatalog } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { writeFailure, type WriteResult } from "@/lib/dashboard/errors";
import {
  checkTimeOff,
  hoursInput,
  invalidFields,
  providerInput,
  timeOffInput,
  validateWeek,
} from "@/lib/dashboard/manage";

/** Create or update a provider (owner only; the database would also allow receptionists). */
export async function saveProvider(input: unknown): Promise<WriteResult<{ id: string }>> {
  const parsed = providerInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid", fields: invalidFields(parsed.error) };
  const session = await getSession();
  if (!session || !canManageCatalog(session.role)) return { ok: false, code: "forbidden" };
  const { id, ...fields } = parsed.data;

  try {
    const supabase = await createSupabaseServerClient();
    if (id) {
      const { data, error } = await supabase
        .from("providers")
        .update(fields)
        .eq("id", id)
        .eq("tenant_id", session.tenant.id)
        .select("id");
      if (error) return writeFailure(error);
      if (!data || data.length === 0) return { ok: false, code: "not_found" };
      return { ok: true, id };
    }
    const { data, error } = await supabase
      .from("providers")
      .insert({ tenant_id: session.tenant.id, ...fields })
      .select("id")
      .single();
    if (error) return writeFailure(error);
    return { ok: true, id: (data as { id: string }).id };
  } catch (e) {
    console.error("save_provider_error", e instanceof Error ? e.message : e);
    return { ok: false, code: "generic" };
  }
}

const toggleInput = z.object({ id: z.uuid(), active: z.boolean() });

export async function setProviderActive(input: unknown): Promise<WriteResult> {
  const parsed = toggleInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const session = await getSession();
  if (!session || !canManageCatalog(session.role)) return { ok: false, code: "forbidden" };
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("providers")
      .update({ is_active: parsed.data.active })
      .eq("id", parsed.data.id)
      .eq("tenant_id", session.tenant.id)
      .select("id");
    if (error) return writeFailure(error);
    if (!data || data.length === 0) return { ok: false, code: "not_found" };
    return { ok: true };
  } catch (e) {
    console.error("set_provider_active_error", e instanceof Error ? e.message : e);
    return { ok: false, code: "generic" };
  }
}

async function ownsProvider(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  tenantId: string,
  providerId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("providers")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("id", providerId)
    .maybeSingle();
  return !!data;
}

/**
 * Replaces a provider's whole weekly schedule. Validated first (inverted or overlapping ranges are
 * rejected, nothing is written). The new rows are inserted before the old ones are removed, so a
 * failed insert leaves the old schedule intact.
 */
export async function saveWorkingHours(input: unknown): Promise<WriteResult<{ rows: number }>> {
  const parsed = hoursInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid", fields: invalidFields(parsed.error) };
  const session = await getSession();
  if (!session || !canManageCatalog(session.role)) return { ok: false, code: "forbidden" };
  const check = validateWeek(parsed.data.days);
  if (!check.ok) return { ok: false, code: check.code, weekday: check.weekday };
  const tenantId = session.tenant.id;
  const providerId = parsed.data.providerId;

  try {
    const supabase = await createSupabaseServerClient();
    if (!(await ownsProvider(supabase, tenantId, providerId))) return { ok: false, code: "not_found" };

    const { data: old, error: oldErr } = await supabase
      .from("working_hours")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("provider_id", providerId);
    if (oldErr) return writeFailure(oldErr);
    const oldIds = ((old ?? []) as { id: string }[]).map((r) => r.id);

    let newIds: string[] = [];
    if (check.rows.length > 0) {
      const { data, error } = await supabase
        .from("working_hours")
        .insert(
          check.rows.map((r) => ({
            tenant_id: tenantId,
            provider_id: providerId,
            weekday: r.weekday,
            start_time: r.start,
            end_time: r.end,
          })),
        )
        .select("id");
      if (error) return writeFailure(error);
      newIds = ((data ?? []) as { id: string }[]).map((r) => r.id);
    }

    if (oldIds.length > 0) {
      const { error } = await supabase
        .from("working_hours")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("provider_id", providerId)
        .in("id", oldIds);
      if (error) {
        // Best effort: take the new rows back out so the schedule is not doubled.
        if (newIds.length > 0) {
          await supabase.from("working_hours").delete().eq("tenant_id", tenantId).in("id", newIds);
        }
        return writeFailure(error);
      }
    }
    return { ok: true, rows: check.rows.length };
  } catch (e) {
    console.error("save_hours_error", e instanceof Error ? e.message : e);
    return { ok: false, code: "generic" };
  }
}

/** Adds a time-off block. Inputs are wall-clock times in the tenant's timezone. */
export async function addTimeOff(
  input: unknown,
): Promise<WriteResult<{ id: string; conflicts: number }>> {
  const parsed = timeOffInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "timeoff_invalid", fields: invalidFields(parsed.error) };
  const session = await getSession();
  if (!session || !canManageCatalog(session.role)) return { ok: false, code: "forbidden" };
  const range = checkTimeOff(parsed.data.start, parsed.data.end, session.tenant.timezone);
  if (!range.ok) return { ok: false, code: "timeoff_invalid", fields: ["end"] };
  const tenantId = session.tenant.id;

  try {
    const supabase = await createSupabaseServerClient();
    if (!(await ownsProvider(supabase, tenantId, parsed.data.providerId))) {
      return { ok: false, code: "not_found" };
    }
    const { data, error } = await supabase
      .from("time_off")
      .insert({
        tenant_id: tenantId,
        provider_id: parsed.data.providerId,
        starts_at: range.startsAt,
        ends_at: range.endsAt,
        reason: parsed.data.reason,
      })
      .select("id")
      .single();
    if (error) return writeFailure(error);

    // Existing bookings are not touched; tell the owner how many now sit inside the block.
    const { count } = await supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("provider_id", parsed.data.providerId)
      .in("status", ["pending_payment", "confirmed"])
      .lt("starts_at", range.endsAt)
      .gt("ends_at", range.startsAt);
    return { ok: true, id: (data as { id: string }).id, conflicts: count ?? 0 };
  } catch (e) {
    console.error("add_time_off_error", e instanceof Error ? e.message : e);
    return { ok: false, code: "generic" };
  }
}

const removeInput = z.object({ id: z.uuid() });

export async function removeTimeOff(input: unknown): Promise<WriteResult> {
  const parsed = removeInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const session = await getSession();
  if (!session || !canManageCatalog(session.role)) return { ok: false, code: "forbidden" };
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("time_off")
      .delete()
      .eq("id", parsed.data.id)
      .eq("tenant_id", session.tenant.id)
      .select("id");
    if (error) return writeFailure(error);
    if (!data || data.length === 0) return { ok: false, code: "not_found" };
    return { ok: true };
  } catch (e) {
    console.error("remove_time_off_error", e instanceof Error ? e.message : e);
    return { ok: false, code: "generic" };
  }
}
