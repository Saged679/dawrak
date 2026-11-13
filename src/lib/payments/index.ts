import "server-only";
import { createFakeProvider } from "./fake";
import { createMoyasarProvider } from "./moyasar";
import type { PaymentProvider } from "./types";

export * from "./types";
export { computeDepositMinor, majorToMinor, minorToMajor } from "./deposit";

export type ProviderEnv = {
  PAYMENT_PROVIDER?: string;
  MOYASAR_SECRET_KEY?: string;
  MOYASAR_WEBHOOK_SECRET?: string;
  /** Explicit secret for the fake webhook. There is no default: unset = the fake webhook rejects everything. */
  FAKE_WEBHOOK_SECRET?: string;
  /** Opt-in for a production build (NODE_ENV=production) that is not a Vercel production deployment, e.g. local e2e. */
  ALLOW_FAKE_PAYMENTS?: string;
  NODE_ENV?: string;
  VERCEL_ENV?: string;
};

export class PaymentsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentsUnavailableError";
  }
}

/**
 * PAYMENT_PROVIDER=moyasar|fake.
 *  - Unset: moyasar when MOYASAR_SECRET_KEY exists, else payments are unavailable. The fake provider is
 *    NEVER chosen implicitly (not by DEMO_MODE, not by a missing key).
 *  - fake: only when PAYMENT_PROVIDER=fake, never on a Vercel production deployment, and on any other
 *    production build (NODE_ENV=production) only with ALLOW_FAKE_PAYMENTS=true. Callers must also
 *    gate it per tenant (is_demo), see providerForTenant().
 *  - moyasar without a key throws (so a production deployment with a missing key refuses to take payments).
 */
export function resolveProvider(env: ProviderEnv = process.env as ProviderEnv): PaymentProvider {
  const wanted = env.PAYMENT_PROVIDER?.trim().toLowerCase() || (env.MOYASAR_SECRET_KEY ? "moyasar" : "");
  if (wanted === "moyasar") {
    if (!env.MOYASAR_SECRET_KEY) throw new PaymentsUnavailableError("MOYASAR_SECRET_KEY is not set");
    return createMoyasarProvider({
      secretKey: env.MOYASAR_SECRET_KEY,
      webhookSecret: env.MOYASAR_WEBHOOK_SECRET ?? "",
    });
  }
  if (wanted === "fake") {
    if (env.VERCEL_ENV === "production") {
      throw new PaymentsUnavailableError("the fake payment provider is not allowed on a production deployment");
    }
    if (env.NODE_ENV === "production" && env.ALLOW_FAKE_PAYMENTS !== "true") {
      throw new PaymentsUnavailableError(
        "the fake payment provider in a production build needs ALLOW_FAKE_PAYMENTS=true",
      );
    }
    return createFakeProvider({
      webhookSecret: env.FAKE_WEBHOOK_SECRET ?? "",
      // successUrl is <site>/<locale>/c/<slug>/pay/<token>/result; the fake checkout lives next to it
      checkoutPath: (i) => `${new URL(i.successUrl).pathname.replace(/\/result$/, "")}/fake`,
    });
  }
  if (env.VERCEL_ENV === "production" || env.NODE_ENV === "production") {
    throw new PaymentsUnavailableError("MOYASAR_SECRET_KEY is not set: no payment provider on a production deployment");
  }
  throw new PaymentsUnavailableError("no payment provider configured");
}

export function getPaymentProvider(): PaymentProvider {
  return resolveProvider();
}

/** The provider to use for one tenant: the fake provider is only ever allowed for is_demo tenants. */
export function providerForTenant(
  tenant: { is_demo: boolean },
  env: ProviderEnv = process.env as ProviderEnv,
): PaymentProvider {
  const p = resolveProvider(env);
  if (p.name === "fake" && !tenant.is_demo) {
    throw new PaymentsUnavailableError("the fake payment provider is only available for demo businesses");
  }
  return p;
}
