import type { ParsedWebhook, PaymentProvider, SettleOutcome } from "./types";

/** Minimal persistence the pipeline needs; the Supabase implementation lives in store.ts. */
export interface PaymentStore {
  findByCheckoutRef(provider: string, checkoutRef: string): Promise<{ id: string } | null>;
  settle(args: {
    paymentId: string;
    provider: string;
    eventId: string;
    eventType: string;
    outcome: "paid" | "failed";
    providerPaymentId: string;
    amountMinor: number;
    currency: string;
  }): Promise<SettleOutcome>;
}

export type ProcessResult =
  | { kind: "ignored"; reason: string }
  | { kind: "settled"; outcome: SettleOutcome };

const PAID = new Set(["payment_paid"]);
// the Moyasar docs spell the failure event both "payment_failed" and "payment_faild"
const FAILED = new Set(["payment_failed", "payment_faild"]);

/**
 * Turns an authenticated provider event into a settlement. The event body is only a hint about
 * WHICH payment changed: status, amount and currency come from the provider's API
 * (provider.fetchPayment), never from the webhook body. Idempotent through settle_payment().
 * Throws when the provider API cannot be reached, so the route answers 5xx and the provider retries.
 */
export async function processPaymentEvent(
  provider: PaymentProvider,
  store: PaymentStore,
  event: ParsedWebhook,
  log: (msg: string, fields?: Record<string, unknown>) => void = () => {},
): Promise<ProcessResult> {
  if (!PAID.has(event.type) && !FAILED.has(event.type)) {
    log("payment_event_ignored_type", { eventId: event.eventId, type: event.type });
    return { kind: "ignored", reason: "type" };
  }
  if (!event.providerPaymentId) return { kind: "ignored", reason: "no_payment_id" };

  const remote = await provider.fetchPayment(event.providerPaymentId);
  if (!remote.checkoutRef) return { kind: "ignored", reason: "no_checkout_ref" };
  // the checkout id on the AUTHORITATIVE payment decides which row this belongs to
  if (event.checkoutRef && event.checkoutRef !== remote.checkoutRef) {
    log("payment_event_ref_mismatch", { eventId: event.eventId });
    return { kind: "ignored", reason: "ref_mismatch" };
  }
  const row = await store.findByCheckoutRef(provider.name, remote.checkoutRef);
  if (!row) {
    log("payment_event_unknown_payment", { eventId: event.eventId });
    return { kind: "ignored", reason: "unknown_payment" };
  }

  if (remote.status !== "paid" && remote.status !== "failed") {
    return { kind: "ignored", reason: `remote_${remote.status}` };
  }
  const outcome = await store.settle({
    paymentId: row.id,
    provider: provider.name,
    eventId: event.eventId,
    eventType: event.type,
    outcome: remote.status,
    providerPaymentId: remote.id,
    amountMinor: remote.amountMinor,
    currency: remote.currency,
  });
  log("payment_event_settled", { eventId: event.eventId, outcome });
  return { kind: "settled", outcome };
}
