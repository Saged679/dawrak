"use server";

import { canEditSettings } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { mapWriteError, type WriteResult } from "@/lib/dashboard/errors";
import { invalidFields, settingsSchema } from "@/lib/dashboard/manage";

/** Columns a demo owner cannot change; the database refuses them too (`demo_readonly`). The deposit is frozen as well (the demo clinic has none). */
const DEMO_LOCKED = ["name_ar", "name_en", "timezone", "currency", "logo_url", "brand_color", "deposit_enabled", "deposit_type", "deposit_value"] as const;

/** Numeric columns come back from PostgREST as numbers or strings; compare by value. */
function sameValue(a: unknown, b: unknown): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (typeof x === "boolean" || typeof y === "boolean") return x === y;
  if (x !== null && y !== null && x !== "" && y !== "" && !Number.isNaN(Number(x)) && !Number.isNaN(Number(y))) return Number(x) === Number(y);
  return x === y;
}

/**
 * Updates the tenant row. Only the columns the database grants `authenticated` UPDATE on
 * (name_ar, name_en, timezone, currency, deposit_*, logo_url, brand_color) are ever sent; the
 * tenant id and the owner check come from the session.
 */
export async function saveSettings(input: unknown): Promise<WriteResult> {
  const session = await getSession();
  if (!session || !canEditSettings(session.role)) return { ok: false, code: "forbidden" };
  const parsed = settingsSchema(session.tenant).safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid", fields: invalidFields(parsed.error) };
  const d = parsed.data;

  try {
    const supabase = await createSupabaseServerClient();
    const deposit = {
      deposit_enabled: d.deposit_enabled,
      deposit_type: d.deposit_type,
      deposit_value: d.deposit_value,
    };
    const fields: Record<string, unknown> = {
      name_ar: d.name_ar,
      name_en: d.name_en,
      timezone: d.timezone,
      currency: d.currency,
      ...deposit,
      logo_url: d.logo_url,
      brand_color: d.brand_color,
    };
    if (session.tenant.is_demo) {
      // Defense in depth: refuse a changed locked field here, and never send the locked columns.
      const { data: cur, error: curErr } = await supabase
        .from("tenants")
        .select(DEMO_LOCKED.join(", "))
        .eq("id", session.tenant.id)
        .maybeSingle();
      if (curErr) return { ok: false, code: mapWriteError(curErr) };
      const now = (cur ?? {}) as unknown as Record<string, unknown>;
      const changed = DEMO_LOCKED.filter((k) => !sameValue(now[k], d[k]));
      if (!cur || changed.length > 0) return { ok: false, code: "demo_readonly", fields: [...changed] };
      // Nothing is writable on a demo business: the form is a no-op that succeeds when nothing changed.
      return { ok: true };
    }
    const { data, error } = await supabase
      .from("tenants")
      .update(fields)
      .eq("id", session.tenant.id)
      .select("id");
    if (error) return { ok: false, code: mapWriteError(error) };
    // RLS turns a denied update into zero rows, not an error.
    if (!data || data.length === 0) return { ok: false, code: "forbidden" };
    return { ok: true };
  } catch (e) {
    console.error("save_settings_error", e instanceof Error ? e.message : e);
    return { ok: false, code: "generic" };
  }
}
