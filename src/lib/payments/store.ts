import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "@/lib/db/client";
import { isPaymentToken, newPaymentToken } from "./tokens";
import type { PaymentStore } from "./process";
import type { SettleOutcome } from "./types";

export function supabasePaymentStore(client: SupabaseClient = getServiceClient()): PaymentStore {
  return {
    async findByCheckoutRef(provider, checkoutRef) {
      const { data, error } = await client
        .from("payments")
        .select("id")
        .eq("provider", provider)
        .eq("provider_ref", checkoutRef)
        .maybeSingle();
      if (error) throw error;
      return (data as { id: string } | null) ?? null;
    },
    async settle(a) {
      const { data, error } = await client.rpc("settle_payment", {
        p_payment_id: a.paymentId,
        p_provider: a.provider,
        p_event_id: a.eventId,
        p_event_type: a.eventType,
        p_outcome: a.outcome,
        p_provider_payment_id: a.providerPaymentId,
        p_amount_minor: a.amountMinor,
        p_currency: a.currency,
      });
      if (error) throw error;
      return data as SettleOutcome;
    },
  };
}

/** Creates the pending payment row for a held appointment and returns its unguessable page token. */
export async function createPendingPayment(
  args: {
    tenantId: string;
    appointmentId: string;
    amountMinor: number;
    currency: string;
    provider: string;
  },
  client: Pick<SupabaseClient, "from"> = getServiceClient(),
): Promise<string> {
  const token = newPaymentToken();
  const { error } = await client.from("payments").insert({
    tenant_id: args.tenantId,
    appointment_id: args.appointmentId,
    amount: args.amountMinor / 100,
    currency: args.currency,
    status: "pending",
    provider: args.provider,
    public_token: token,
  });
  if (error) throw error;
  return token;
}

export type PaymentView = {
  paymentId: string;
  token: string;
  status: "pending" | "paid" | "failed" | "refunded" | "refund_due";
  provider: string;
  amountMinor: number;
  currency: string;
  checkoutUrl: string | null;
  providerRef: string | null;
  tenant: {
    id: string;
    slug: string;
    name_ar: string;
    name_en: string | null;
    timezone: string;
    brand_color: string | null;
    is_demo: boolean;
  };
  appointment: {
    id: string;
    status: string;
    startsAt: string;
    paymentExpiresAt: string | null;
    serviceNameAr: string;
    serviceNameEn: string | null;
  };
};

/**
 * Loads a payment page by its unguessable token. Returns null (=> 404) when the token is malformed,
 * unknown, or belongs to a different clinic than the slug in the URL, so one tenant's link never
 * resolves under another tenant's path.
 */
export async function loadPaymentView(
  token: string,
  slug: string,
  client: SupabaseClient = getServiceClient(),
): Promise<PaymentView | null> {
  if (!isPaymentToken(token)) return null;
  const { data: pay, error } = await client
    .from("payments")
    .select("id, tenant_id, appointment_id, status, provider, provider_ref, amount, currency, checkout_url")
    .eq("public_token", token)
    .maybeSingle();
  if (error) throw error;
  if (!pay) return null;
  const p = pay as Record<string, unknown>;

  const { data: tenant, error: te } = await client
    .from("tenants")
    .select("id, slug, name_ar, name_en, timezone, brand_color, is_demo")
    .eq("id", p.tenant_id as string)
    .maybeSingle();
  if (te) throw te;
  const t = tenant as PaymentView["tenant"] | null;
  if (!t || t.slug !== slug) return null;

  const { data: appt, error: ae } = await client
    .from("appointments")
    .select("id, status, starts_at, payment_expires_at, service_id")
    .eq("id", p.appointment_id as string)
    .eq("tenant_id", t.id)
    .maybeSingle();
  if (ae) throw ae;
  if (!appt) return null;
  const a = appt as Record<string, unknown>;

  const { data: svc, error: se } = await client
    .from("services")
    .select("name_ar, name_en")
    .eq("id", a.service_id as string)
    .eq("tenant_id", t.id)
    .maybeSingle();
  if (se) throw se;
  const s = (svc as { name_ar: string; name_en: string | null } | null) ?? { name_ar: "", name_en: null };

  return {
    paymentId: p.id as string,
    token,
    status: p.status as PaymentView["status"],
    provider: p.provider as string,
    amountMinor: Math.round(Number(p.amount) * 100),
    currency: p.currency as string,
    checkoutUrl: (p.checkout_url as string | null) ?? null,
    providerRef: (p.provider_ref as string | null) ?? null,
    tenant: t,
    appointment: {
      id: a.id as string,
      status: a.status as string,
      startsAt: a.starts_at as string,
      paymentExpiresAt: (a.payment_expires_at as string | null) ?? null,
      serviceNameAr: s.name_ar,
      serviceNameEn: s.name_en,
    },
  };
}

export type PayState = "paid" | "awaiting" | "failed" | "expired" | "refund_due";

/** What the page should show, from server state and the server clock only. */
export function derivePayState(v: PaymentView, now: Date = new Date()): PayState {
  if (v.status === "refund_due" || v.status === "refunded") return "refund_due";
  if (v.status === "paid") return "paid";
  const a = v.appointment;
  if (a.status === "confirmed" || a.status === "completed") return "paid";
  const expired =
    a.status !== "pending_payment" ||
    (a.paymentExpiresAt !== null && new Date(a.paymentExpiresAt).getTime() <= now.getTime());
  if (expired) return "expired";
  return v.status === "failed" ? "failed" : "awaiting";
}

export async function saveCheckout(
  paymentId: string,
  providerRef: string,
  checkoutUrl: string,
  client: SupabaseClient = getServiceClient(),
): Promise<void> {
  const { error } = await client
    .from("payments")
    .update({ provider_ref: providerRef, checkout_url: checkoutUrl })
    .eq("id", paymentId)
    .is("checkout_url", null);
  if (error) throw error;
}
