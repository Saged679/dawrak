import { safeEqual } from "./moyasar";
import {
  WebhookAuthError,
  WebhookFormatError,
  type Checkout,
  type CheckoutInput,
  type ParsedWebhook,
  type PaymentProvider,
  type ProviderPayment,
} from "./types";

/**
 * Local/demo provider: no network, no keys. The "hosted checkout" is our own page
 * (/[locale]/c/[slug]/pay/[token]/fake) with two buttons that call the same settlement pipeline as
 * the real webhook. Only selectable when DEMO_MODE=true (see index.ts).
 *
 * The outcome travels in the fake payment id so fetchPayment() needs no storage:
 *   fake_<paid|failed>_<amountMinor>_<CUR>_<checkoutRef>
 */

export function fakePaymentId(
  outcome: "paid" | "failed",
  amountMinor: number,
  currency: string,
  checkoutRef: string,
): string {
  return `fake_${outcome}_${amountMinor}_${currency.toUpperCase()}_${checkoutRef}`;
}

export function createFakeProvider(cfg: {
  webhookSecret: string;
  checkoutPath: (input: CheckoutInput) => string;
}): PaymentProvider {
  return {
    name: "fake",

    async createCheckout(input: CheckoutInput): Promise<Checkout> {
      return { providerRef: `fakeinv_${input.paymentId}`, checkoutUrl: cfg.checkoutPath(input) };
    },

    verifyAndParseWebhook(rawBody: string): ParsedWebhook {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        throw new WebhookAuthError();
      }
      const token = typeof obj?.secret_token === "string" ? obj.secret_token : "";
      if (!cfg.webhookSecret || !safeEqual(token, cfg.webhookSecret)) throw new WebhookAuthError();
      const data = (obj.data ?? {}) as Record<string, unknown>;
      if (typeof obj.id !== "string" || typeof obj.type !== "string") throw new WebhookFormatError();
      return {
        eventId: obj.id,
        type: obj.type,
        providerPaymentId: typeof data.id === "string" ? data.id : null,
        checkoutRef: typeof data.invoice_id === "string" ? data.invoice_id : null,
      };
    },

    async fetchPayment(id: string): Promise<ProviderPayment> {
      const m = /^fake_(paid|failed)_(\d+)_([A-Z]{3})_(.+)$/.exec(id);
      if (!m) throw new Error("fake_payment_id_invalid");
      return {
        id,
        status: m[1] as "paid" | "failed",
        amountMinor: Number(m[2]),
        currency: m[3],
        checkoutRef: m[4],
      };
    },
  };
}
