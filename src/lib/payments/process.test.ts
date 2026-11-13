import { describe, expect, it, vi } from "vitest";
import { createFakeProvider, fakePaymentId } from "./fake";
import { processPaymentEvent, type PaymentStore } from "./process";
import type { ParsedWebhook, PaymentProvider, ProviderPayment, SettleOutcome } from "./types";

const fake = createFakeProvider({ webhookSecret: "s", checkoutPath: () => "/x" });

function providerWith(remote: ProviderPayment | Error): PaymentProvider {
  return {
    ...fake,
    name: "moyasar",
    fetchPayment: vi.fn(async () => {
      if (remote instanceof Error) throw remote;
      return remote;
    }),
  };
}

/** In-memory stand-in for settle_payment's idempotency (the real logic is pgTAP-tested). */
function memoryStore(outcome: SettleOutcome = "confirmed") {
  const seen = new Set<string>();
  const settle = vi.fn(async (a: { eventId: string }): Promise<SettleOutcome> => {
    if (seen.has(a.eventId)) return "duplicate";
    seen.add(a.eventId);
    return outcome;
  });
  const store: PaymentStore = {
    findByCheckoutRef: vi.fn(async (_p, ref) => (ref === "inv-1" ? { id: "row-1" } : null)),
    settle: settle as unknown as PaymentStore["settle"],
  };
  return { store, settle };
}

const event = (over: Partial<ParsedWebhook> = {}): ParsedWebhook => ({
  eventId: "evt-1",
  type: "payment_paid",
  providerPaymentId: "pay_1",
  checkoutRef: "inv-1",
  ...over,
});
const remotePaid: ProviderPayment = { id: "pay_1", status: "paid", amountMinor: 5000, currency: "SAR", checkoutRef: "inv-1" };

describe("processPaymentEvent", () => {
  it("settles with the amount, currency and status from the provider API, not the webhook body", async () => {
    const { store, settle } = memoryStore();
    const r = await processPaymentEvent(providerWith(remotePaid), store, event());
    expect(r).toEqual({ kind: "settled", outcome: "confirmed" });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "row-1", outcome: "paid", amountMinor: 5000, currency: "SAR", providerPaymentId: "pay_1" }),
    );
  });

  it("a webhook claiming 'paid' while the API says failed is settled as failed", async () => {
    const { store, settle } = memoryStore("failed");
    await processPaymentEvent(providerWith({ ...remotePaid, status: "failed" }), store, event());
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("a still-initiated payment changes nothing", async () => {
    const { store, settle } = memoryStore();
    const r = await processPaymentEvent(providerWith({ ...remotePaid, status: "pending" }), store, event());
    expect(r).toEqual({ kind: "ignored", reason: "remote_pending" });
    expect(settle).not.toHaveBeenCalled();
  });

  it("amount mismatch: the (wrong) provider amount is passed on so settle_payment flags it, never confirms", async () => {
    const { store, settle } = memoryStore("amount_mismatch");
    const r = await processPaymentEvent(providerWith({ ...remotePaid, amountMinor: 100 }), store, event());
    expect(r).toEqual({ kind: "settled", outcome: "amount_mismatch" });
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 100 }));
  });

  it("replays and duplicates are harmless", async () => {
    const { store } = memoryStore();
    const p = providerWith(remotePaid);
    expect(await processPaymentEvent(p, store, event())).toEqual({ kind: "settled", outcome: "confirmed" });
    expect(await processPaymentEvent(p, store, event())).toEqual({ kind: "settled", outcome: "duplicate" });
    expect(await processPaymentEvent(p, store, event())).toEqual({ kind: "settled", outcome: "duplicate" });
  });

  it("payment after the hold expired and the slot was re-booked is reported as refund_due (no double booking)", async () => {
    const { store } = memoryStore("refund_due");
    expect(await processPaymentEvent(providerWith(remotePaid), store, event())).toEqual({ kind: "settled", outcome: "refund_due" });
  });

  it("ignores unrelated event types, unknown payments and invoice mix-ups without settling", async () => {
    const { store, settle } = memoryStore();
    const p = providerWith(remotePaid);
    expect(await processPaymentEvent(p, store, event({ type: "payment_refunded" }))).toMatchObject({ kind: "ignored" });
    expect(await processPaymentEvent(p, store, event({ providerPaymentId: null }))).toMatchObject({ kind: "ignored" });
    expect(await processPaymentEvent(providerWith({ ...remotePaid, checkoutRef: "inv-other" }), store, event())).toMatchObject({
      kind: "ignored",
      reason: "ref_mismatch",
    });
    expect(await processPaymentEvent(providerWith({ ...remotePaid, checkoutRef: "inv-zzz" }), store, event({ checkoutRef: "inv-zzz" }))).toMatchObject({
      kind: "ignored",
      reason: "unknown_payment",
    });
    expect(settle).not.toHaveBeenCalled();
  });

  it("propagates provider API failures so the webhook answers 5xx and the provider retries", async () => {
    const { store, settle } = memoryStore();
    await expect(processPaymentEvent(providerWith(new Error("moyasar_http_503")), store, event())).rejects.toThrow("moyasar_http_503");
    expect(settle).not.toHaveBeenCalled();
  });

  it("accepts both spellings of the failure event (docs use payment_failed and payment_faild)", async () => {
    for (const type of ["payment_failed", "payment_faild"]) {
      const { store, settle } = memoryStore("failed");
      await processPaymentEvent(providerWith({ ...remotePaid, status: "failed" }), store, event({ type }));
      expect(settle).toHaveBeenCalledTimes(1);
    }
  });
});

describe("fake provider", () => {
  it("round-trips the outcome through the fake payment id with no network", async () => {
    const id = fakePaymentId("paid", 5000, "sar", "fakeinv_abc");
    const r = await fake.fetchPayment(id);
    expect(r).toEqual({ id, status: "paid", amountMinor: 5000, currency: "SAR", checkoutRef: "fakeinv_abc" });
    await expect(fake.fetchPayment("pay_real_id")).rejects.toThrow();
  });
  it("checks the webhook secret too", () => {
    expect(() => fake.verifyAndParseWebhook(JSON.stringify({ id: "1", type: "t", secret_token: "wrong" }))).toThrow();
    expect(fake.verifyAndParseWebhook(JSON.stringify({ id: "1", type: "t", secret_token: "s", data: {} })).eventId).toBe("1");
  });
});
