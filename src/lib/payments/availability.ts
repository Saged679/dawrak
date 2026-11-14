import { providerForTenant, type ProviderEnv } from "./index";

type TenantDeposit = { is_demo: boolean; deposit_enabled: boolean };

/**
 * True when the business takes a deposit: the database then books every appointment as a pending_payment
 * hold (create_public_booking keys on deposit_enabled), so this is the flag that matters.
 */
export function tenantRequiresDeposit(tenant: Pick<TenantDeposit, "deposit_enabled">): boolean {
  return tenant.deposit_enabled === true;
}

/**
 * Whether a payment provider is usable for this tenant right now. Reuses providerForTenant, so every
 * production guard applies (no fake on a Vercel production deployment, fake only for demo tenants, fake in a
 * production build only with ALLOW_FAKE_PAYMENTS, moyasar needs its key). Never throws.
 */
export function paymentsAvailableFor(
  tenant: Pick<TenantDeposit, "is_demo">,
  env: ProviderEnv = process.env as ProviderEnv,
): boolean {
  try {
    providerForTenant(tenant, env);
    return true;
  } catch {
    return false;
  }
}

/** A deposit tenant with no usable provider: a booking must be refused BEFORE anything is created. */
export function depositPaymentsBlocked(tenant: TenantDeposit, env?: ProviderEnv): boolean {
  return tenantRequiresDeposit(tenant) && !paymentsAvailableFor(tenant, env);
}
