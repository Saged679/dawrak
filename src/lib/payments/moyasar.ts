import { createHash, timingSafeEqual } from "node:crypto";
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
 * Moyasar adapter, TEST MODE first (sk_test_ keys; no real money, no commercial registration).
 *
 * Documentation used (read 2026-11-13, not from memory):
 *  - Auth: HTTP Basic, username = secret key, EMPTY password, HTTPS only.
 *      https://docs.moyasar.com/api/authentication  (also llms-full.txt "Basic Auth")
 *  - Hosted checkout = Invoices API: POST https://api.moyasar.com/v1/invoices with amount (smallest
 *    currency unit, 100 halalas = 1 SAR), currency (default SAR), description (required),
 *    success_url, back_url, expired_at, metadata; Moyasar "gives you a link to the invoice on our
 *    website" and handles the payment form, so card data never touches our servers.
 *      https://docs.moyasar.com/guides/invoices/creating-invoices
 *  - Webhooks: JSON body { id, type, created_at, secret_token, account_name, live, data }.
 *    secret_token is "assigned by the consumer to secure the webhook" ("a password you need to
 *    validate on your server to make sure the notification is coming from moyasar"). There is NO
 *    HMAC signature header in the docs; authenticity = constant-time check of body.secret_token.
 *    Endpoint must answer 2xx quickly; non-2xx is retried 5 more times (1m,10m,30m,1h,2h).
 *    Payment events: payment_paid, payment_failed (the docs table spells it "payment_faild").
 *      https://docs.moyasar.com/api/other/webhooks/webhook-reference
 *      https://docs.moyasar.com/guides/dashboard/setting-up-webhooks
 *  - webhook_verification event carries data.verification_code (6 digits) that must be sent to
 *    POST /v1/webhooks/:id/verify before the webhook receives any event.
 *      https://docs.moyasar.com/api/other/webhooks/webhook-reference (Verify Webhook section)
 *  - Fetch payment: GET https://api.moyasar.com/v1/payments/{id}; fields id, status
 *    (initiated | paid | failed | authorized | captured | refunded | voided | verified),
 *    amount (integer minor units), currency, invoice_id.
 *      https://docs.moyasar.com/guides/card-payments/basic-integration (verification example)
 *      https://docs.moyasar.com/api/payments/payment-status-reference
 *  - Test cards (any future expiry, any CVC, name of 2+ words): success 4111111111111111 (Visa),
 *    4201320111111010 (mada); failure 4123120000000000 (Visa, "UNSPECIFIED FAILURE").
 *      https://docs.moyasar.com/guides/card-payments/test-cards
 *
 * DOUBTS (could not be confirmed from the public docs): (1) the Create Invoice response schema is
 * not published on the guide page; we read `id` and `url` (the standard Moyasar fields) and fail
 * closed when they are missing. (2) Whether payment webhooks include the invoice's metadata is not
 * documented, so we match a webhook to our row by payment.invoice_id, never by metadata.
 */

const API = "https://api.moyasar.com/v1";

export type MoyasarConfig = {
  secretKey: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
};

function authHeader(secretKey: string): string {
  return `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
}

/** Constant-time string equality (hashes first so lengths never leak or throw). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function createMoyasarProvider(cfg: MoyasarConfig): PaymentProvider {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = cfg.apiBase ?? API;

  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: authHeader(cfg.secretKey),
        "Content-Type": "application/json",
        Accept: "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!res.ok) {
      // never include the body or headers: they can echo request data
      throw new Error(`moyasar_http_${res.status}`);
    }
    return res.json();
  }

  return {
    name: "moyasar",

    async createCheckout(input: CheckoutInput): Promise<Checkout> {
      const body = {
        amount: input.amountMinor,
        currency: input.currency,
        description: input.description,
        success_url: input.successUrl,
        back_url: input.backUrl,
        expired_at: input.expiresAt.toISOString(),
        metadata: { dawrak_payment_id: input.paymentId },
      };
      const out = (await call("/invoices", {
        method: "POST",
        body: JSON.stringify(body),
      })) as Record<string, unknown>;
      const id = str(out.id);
      const url = str(out.url);
      if (!id || !url || !/^https:\/\//.test(url)) throw new Error("moyasar_invoice_response_invalid");
      return { providerRef: id, checkoutUrl: url };
    },

    verifyAndParseWebhook(rawBody: string): ParsedWebhook {
      // Authenticate first. Fail closed when the secret is not configured.
      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch {
        throw new WebhookAuthError();
      }
      const obj = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
      const token = typeof obj.secret_token === "string" ? obj.secret_token : "";
      if (!cfg.webhookSecret || !safeEqual(token, cfg.webhookSecret)) throw new WebhookAuthError();

      const eventId = str(obj.id);
      const type = str(obj.type);
      if (!eventId || !type) throw new WebhookFormatError();
      const data = (obj.data && typeof obj.data === "object" ? obj.data : {}) as Record<string, unknown>;

      if (type === "webhook_verification") {
        return {
          eventId,
          type,
          providerPaymentId: null,
          checkoutRef: null,
          verificationCode: str(data.verification_code) ?? undefined,
        };
      }
      return {
        eventId,
        type,
        providerPaymentId: type.startsWith("payment_") ? str(data.id) : null,
        checkoutRef: str(data.invoice_id),
      };
    },

    async fetchPayment(providerPaymentId: string): Promise<ProviderPayment> {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(providerPaymentId)) throw new Error("moyasar_payment_id_invalid");
      const p = (await call(`/payments/${encodeURIComponent(providerPaymentId)}`)) as Record<
        string,
        unknown
      >;
      const amount = typeof p.amount === "number" ? p.amount : Number.NaN;
      const currency = str(p.currency);
      if (!Number.isInteger(amount) || !currency || str(p.id) !== providerPaymentId) {
        throw new Error("moyasar_payment_response_invalid");
      }
      const s = p.status;
      return {
        id: providerPaymentId,
        status: s === "paid" ? "paid" : s === "failed" ? "failed" : s === "initiated" ? "pending" : "other",
        amountMinor: amount,
        currency: currency.toUpperCase(),
        checkoutRef: str(p.invoice_id),
      };
    },
  };
}
