/**
 * Payment provider abstraction. Money is always integer MINOR units (halalas for SAR).
 * Providers never see card data: checkout is a redirect to the provider's hosted page.
 */

export type ProviderName = "moyasar" | "fake";

export type CheckoutInput = {
  /** our payments.id (opaque uuid; sent as metadata only) */
  paymentId: string;
  amountMinor: number;
  currency: string;
  description: string;
  /** where the provider sends the customer after paying / when they press back */
  successUrl: string;
  backUrl: string;
  /** the invoice stops accepting payment at this instant (our hold expiry) */
  expiresAt: Date;
};

export type Checkout = { providerRef: string; checkoutUrl: string };

/** Provider-reported state of one payment, fetched from the provider's API (authoritative). */
export type ProviderPayment = {
  id: string;
  status: "paid" | "failed" | "pending" | "other";
  amountMinor: number;
  currency: string;
  /** the invoice/checkout this payment belongs to (our payments.provider_ref) */
  checkoutRef: string | null;
};

export type ParsedWebhook = {
  eventId: string;
  type: string;
  /** the provider's payment id when the event carries a payment, else null */
  providerPaymentId: string | null;
  /** invoice id carried by the event (a hint only; re-checked against the fetched payment) */
  checkoutRef: string | null;
  /** one-time code of a webhook_verification event */
  verificationCode?: string;
};

export class WebhookAuthError extends Error {
  constructor(message = "webhook_unauthorized") {
    super(message);
    this.name = "WebhookAuthError";
  }
}

export class WebhookFormatError extends Error {
  constructor(message = "webhook_malformed") {
    super(message);
    this.name = "WebhookFormatError";
  }
}

export interface PaymentProvider {
  readonly name: ProviderName;
  createCheckout(input: CheckoutInput): Promise<Checkout>;
  /**
   * Authenticates the request (throws WebhookAuthError, BEFORE anything else is parsed or done) and
   * returns the event. Never trust amount/status in it: call fetchPayment.
   */
  verifyAndParseWebhook(rawBody: string): ParsedWebhook;
  fetchPayment(providerPaymentId: string): Promise<ProviderPayment>;
}

/** What settle_payment() returns (see supabase/migrations/20261113000012_payments.sql). */
export type SettleOutcome =
  | "duplicate"
  | "confirmed"
  | "confirmed_after_expiry"
  | "refund_due"
  | "amount_mismatch"
  | "already_paid"
  | "failed"
  | "not_found";
