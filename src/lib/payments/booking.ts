import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeDepositMinor } from "./deposit";
import { providerForTenant } from "./index";
import { createPendingPayment } from "./store";

export type DepositTenant = {
  id: string;
  slug: string;
  is_demo: boolean;
  deposit_type: "fixed" | "percent" | null;
  deposit_value: number | string | null;
};

/**
 * Creates the pending payment row for a held (pending_payment) appointment and returns the path of
 * its unguessable payment page, or null when there is nothing to pay (deposit rounds to 0).
 * Shared by the web booking form and the chat assistant. Throws when no provider is usable for the
 * tenant (providerForTenant) or the insert fails; callers decide how to degrade.
 */
export async function createDepositPayment(
  a: {
    tenant: DepositTenant;
    appointmentId: string;
    price: number;
    currency: string;
    locale: "ar" | "en";
  },
  client?: Pick<SupabaseClient, "from">,
): Promise<{ token: string; path: string } | null> {
  const amountMinor = computeDepositMinor(a.price, {
    type: a.tenant.deposit_type,
    value: a.tenant.deposit_value === null ? null : Number(a.tenant.deposit_value),
  });
  if (amountMinor <= 0) return null;
  const provider = providerForTenant(a.tenant);
  const token = await createPendingPayment(
    {
      tenantId: a.tenant.id,
      appointmentId: a.appointmentId,
      amountMinor,
      currency: a.currency,
      provider: provider.name,
    },
    client,
  );
  return { token, path: `/${a.locale}/c/${a.tenant.slug}/pay/${token}` };
}
