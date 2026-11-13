import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "@/lib/db/client";
import type { ClaimedReminder, CompleteOutcome, ReminderStore } from "./dispatch";

type Row = {
  reminder_id: string;
  kind: "24h" | "2h";
  attempts: number;
  tenant_id: string;
  tenant_slug: string;
  tenant_name_ar: string;
  tenant_name_en: string | null;
  timezone: string;
  is_demo: boolean;
  appointment_id: string;
  starts_at: string;
  provider_name_ar: string;
  provider_name_en: string | null;
  service_name_ar: string;
  service_name_en: string | null;
  customer_id: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  customer_locale: string;
  demo_session_hash: string | null;
};

export function supabaseReminderStore(client: SupabaseClient = getServiceClient()): ReminderStore {
  return {
    async claim(limit) {
      const { data, error } = await client.rpc("claim_due_reminders", { p_limit: limit });
      if (error) throw error;
      return ((data as Row[] | null) ?? []).map(
        (r): ClaimedReminder => ({
          reminderId: r.reminder_id,
          kind: r.kind,
          attempts: r.attempts,
          tenantId: r.tenant_id,
          tenantSlug: r.tenant_slug,
          tenantNameAr: r.tenant_name_ar,
          tenantNameEn: r.tenant_name_en,
          timezone: r.timezone,
          isDemo: r.is_demo,
          appointmentId: r.appointment_id,
          startsAt: r.starts_at,
          providerNameAr: r.provider_name_ar,
          providerNameEn: r.provider_name_en,
          serviceNameAr: r.service_name_ar,
          serviceNameEn: r.service_name_en,
          customerId: r.customer_id,
          customerName: r.customer_name,
          customerPhone: r.customer_phone,
          customerEmail: r.customer_email,
          customerLocale: r.customer_locale === "en" ? "en" : "ar",
          demoSessionHash: r.demo_session_hash,
        }),
      );
    },
    async complete(id, r: CompleteOutcome) {
      const { error } = await client.rpc("complete_reminder", {
        p_id: id,
        p_outcome: r.outcome,
        p_error: r.outcome === "sent" ? null : r.error,
        p_retry_at: r.outcome === "retry" ? r.retryAt.toISOString() : null,
      });
      if (error) throw error;
    },
    async issueLink(tenantId, phone) {
      const { data, error } = await client.rpc("issue_customer_magic_link", {
        p_tenant_id: tenantId,
        p_phone: phone,
      });
      if (error) throw error;
      return typeof data === "string" ? data : null;
    },
  };
}
