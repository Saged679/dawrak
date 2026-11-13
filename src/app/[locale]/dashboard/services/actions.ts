"use server";

import { z } from "zod";
import { canManageCatalog } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { writeFailure, type WriteResult } from "@/lib/dashboard/errors";
import { invalidFields, serviceInput } from "@/lib/dashboard/manage";

/**
 * Create or update a service and the providers who perform it. Tenant and role come from the
 * session. The role check is stricter than RLS (which also lets receptionists write); RLS and the
 * composite foreign keys remain the backstop. supabase-js has no transaction, so the service row
 * is written first and the provider links second; a failure in between leaves the service saved
 * with its previous links and reports an error.
 */
export async function saveService(input: unknown): Promise<WriteResult<{ id: string }>> {
  const parsed = serviceInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid", fields: invalidFields(parsed.error) };
  const session = await getSession();
  if (!session || !canManageCatalog(session.role)) return { ok: false, code: "forbidden" };
  const d = parsed.data;
  const tenantId = session.tenant.id;

  try {
    const supabase = await createSupabaseServerClient();
    const wanted = [...new Set(d.provider_ids)];
    if (wanted.length > 0) {
      const { data, error } = await supabase
        .from("providers")
        .select("id")
        .eq("tenant_id", tenantId)
        .in("id", wanted);
      if (error) return writeFailure(error);
      if ((data ?? []).length !== wanted.length) {
        return { ok: false, code: "invalid", fields: ["provider_ids"] };
      }
    }

    const fields = {
      name_ar: d.name_ar,
      name_en: d.name_en,
      description_ar: d.description_ar,
      description_en: d.description_en,
      duration_min: d.duration_min,
      buffer_min: d.buffer_min,
      price: d.price,
      is_active: d.is_active,
    };

    let id = d.id;
    if (id) {
      const { data, error } = await supabase
        .from("services")
        .update(fields)
        .eq("id", id)
        .eq("tenant_id", tenantId)
        .select("id");
      if (error) return writeFailure(error);
      if (!data || data.length === 0) return { ok: false, code: "not_found" };
    } else {
      const { data, error } = await supabase
        .from("services")
        .insert({ tenant_id: tenantId, ...fields })
        .select("id")
        .single();
      if (error) return writeFailure(error);
      id = (data as { id: string }).id;
    }

    const { data: current, error: curErr } = await supabase
      .from("provider_services")
      .select("provider_id")
      .eq("tenant_id", tenantId)
      .eq("service_id", id);
    if (curErr) return writeFailure(curErr);
    const have = new Set(((current ?? []) as { provider_id: string }[]).map((r) => r.provider_id));
    const toAdd = wanted.filter((p) => !have.has(p));
    const toRemove = [...have].filter((p) => !wanted.includes(p));

    if (toRemove.length > 0) {
      const { error } = await supabase
        .from("provider_services")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("service_id", id)
        .in("provider_id", toRemove);
      if (error) return writeFailure(error);
    }
    if (toAdd.length > 0) {
      const { error } = await supabase
        .from("provider_services")
        .insert(toAdd.map((provider_id) => ({ tenant_id: tenantId, provider_id, service_id: id! })));
      if (error) return writeFailure(error);
    }
    return { ok: true, id };
  } catch (e) {
    console.error("save_service_error", e instanceof Error ? e.message : e);
    return { ok: false, code: "generic" };
  }
}

const toggleInput = z.object({ id: z.uuid(), active: z.boolean() });

export async function setServiceActive(input: unknown): Promise<WriteResult> {
  const parsed = toggleInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const session = await getSession();
  if (!session || !canManageCatalog(session.role)) return { ok: false, code: "forbidden" };
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("services")
      .update({ is_active: parsed.data.active })
      .eq("id", parsed.data.id)
      .eq("tenant_id", session.tenant.id)
      .select("id");
    if (error) return writeFailure(error);
    if (!data || data.length === 0) return { ok: false, code: "not_found" };
    return { ok: true };
  } catch (e) {
    console.error("set_service_active_error", e instanceof Error ? e.message : e);
    return { ok: false, code: "generic" };
  }
}
