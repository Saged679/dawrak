import { describe, expect, it, vi } from "vitest";
import { createMoyasarProvider, safeEqual } from "./moyasar";
import { WebhookAuthError, WebhookFormatError } from "./types";

const SECRET = "whsec_test_0123456789";
const KEY = "sk_test_dummy";

function provider(fetchImpl: typeof fetch, webhookSecret = SECRET) {
  return createMoyasarProvider({ secretKey: KEY, webhookSecret, fetchImpl });
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const never = (() => {
  throw new Error("network must not be used");
}) as unknown as typeof fetch;

const paidEvent = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "evt-1",
    type: "payment_paid",
    created_at: "2026-11-13T10:00:00Z",
    secret_token: SECRET,
    account_name: "Test",
    live: false,
    data: { id: "pay_12345678", status: "paid", amount: 99999, currency: "SAR", invoice_id: "inv-1" },
    ...over,
  });

describe("createCheckout", () => {
  it("posts an invoice with Basic auth (key as username, empty password) and minor-unit amount", async () => {
    const f = vi.fn(async () => json({ id: "inv-1", url: "https://checkout.moyasar.com/invoices/inv-1" }));
    const out = await provider(f as unknown as typeof fetch).createCheckout({
      paymentId: "p1",
      amountMinor: 5000,
      currency: "SAR",
      description: "Deposit - Clinic",
      successUrl: "https://x.test/ar/c/a/pay/t/result",
      backUrl: "https://x.test/ar/c/a/pay/t",
      expiresAt: new Date("2026-11-13T10:15:00Z"),
    });
    expect(out).toEqual({ providerRef: "inv-1", checkoutUrl: "https://checkout.moyasar.com/invoices/inv-1" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.moyasar.com/v1/invoices");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`,
    );
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      amount: 5000,
      currency: "SAR",
      description: "Deposit - Clinic",
      expired_at: "2026-11-13T10:15:00.000Z",
    });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("fails closed on an HTTP error and on a response without id/https url", async () => {
    const input = {
      paymentId: "p1", amountMinor: 100, currency: "SAR", description: "d",
      successUrl: "https://x.test/r", backUrl: "https://x.test/b", expiresAt: new Date(),
    };
    await expect(provider((async () => json({ message: "bad" }, 422)) as typeof fetch).createCheckout(input)).rejects.toThrow(
      "moyasar_http_422",
    );
    await expect(provider((async () => json({ id: "x" })) as typeof fetch).createCheckout(input)).rejects.toThrow(
      "moyasar_invoice_response_invalid",
    );
    await expect(
      provider((async () => json({ id: "x", url: "http://insecure" })) as typeof fetch).createCheckout(input),
    ).rejects.toThrow("moyasar_invoice_response_invalid");
  });
});

describe("verifyAndParseWebhook (authenticity)", () => {
  const p = provider(never);

  it("accepts the right secret_token and parses the event without any network call", () => {
    expect(p.verifyAndParseWebhook(paidEvent())).toEqual({
      eventId: "evt-1",
      type: "payment_paid",
      providerPaymentId: "pay_12345678",
      checkoutRef: "inv-1",
    });
  });

  it("rejects a wrong, empty or missing secret_token", () => {
    expect(() => p.verifyAndParseWebhook(paidEvent({ secret_token: "nope" }))).toThrow(WebhookAuthError);
    expect(() => p.verifyAndParseWebhook(paidEvent({ secret_token: "" }))).toThrow(WebhookAuthError);
    expect(() => p.verifyAndParseWebhook(paidEvent({ secret_token: undefined }))).toThrow(WebhookAuthError);
    expect(() => p.verifyAndParseWebhook(paidEvent({ secret_token: 123 }))).toThrow(WebhookAuthError);
  });

  it("rejects non-JSON bodies as unauthorized (no information leak)", () => {
    expect(() => p.verifyAndParseWebhook("not json")).toThrow(WebhookAuthError);
    expect(() => p.verifyAndParseWebhook("null")).toThrow(WebhookAuthError);
  });

  it("fails closed when no webhook secret is configured, even for an empty token", () => {
    const open = provider(never, "");
    expect(() => open.verifyAndParseWebhook(paidEvent({ secret_token: "" }))).toThrow(WebhookAuthError);
  });

  it("authenticated but malformed events are a format error, not an auth error", () => {
    expect(() => p.verifyAndParseWebhook(paidEvent({ id: undefined }))).toThrow(WebhookFormatError);
  });

  it("surfaces the one-time code of a webhook_verification event", () => {
    const e = p.verifyAndParseWebhook(
      paidEvent({ type: "webhook_verification", data: { webhook_id: "w", verification_code: "482913" } }),
    );
    expect(e.verificationCode).toBe("482913");
    expect(e.providerPaymentId).toBeNull();
  });

  it("safeEqual is exact and length-safe", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
    expect(safeEqual("a", "aa")).toBe(false);
  });
});

describe("fetchPayment (authoritative status)", () => {
  it("maps status, amount, currency and invoice id", async () => {
    const f = vi.fn(async () =>
      json({ id: "pay_12345678", status: "paid", amount: 5000, currency: "SAR", invoice_id: "inv-1" }),
    );
    const r = await provider(f as unknown as typeof fetch).fetchPayment("pay_12345678");
    expect(r).toEqual({ id: "pay_12345678", status: "paid", amountMinor: 5000, currency: "SAR", checkoutRef: "inv-1" });
    expect((f.mock.calls[0] as unknown[])[0]).toBe("https://api.moyasar.com/v1/payments/pay_12345678");
  });

  it("maps initiated/failed/other and rejects mismatched ids or junk ids", async () => {
    const mk = (status: string) =>
      provider((async () => json({ id: "pay_12345678", status, amount: 1, currency: "sar" })) as typeof fetch);
    expect((await mk("initiated").fetchPayment("pay_12345678")).status).toBe("pending");
    expect((await mk("failed").fetchPayment("pay_12345678")).status).toBe("failed");
    expect((await mk("refunded").fetchPayment("pay_12345678")).status).toBe("other");
    expect((await mk("paid").fetchPayment("pay_12345678")).currency).toBe("SAR");
    await expect(
      provider((async () => json({ id: "other_id_000", status: "paid", amount: 1, currency: "SAR" })) as typeof fetch).fetchPayment(
        "pay_12345678",
      ),
    ).rejects.toThrow("moyasar_payment_response_invalid");
    await expect(provider(never).fetchPayment("../../etc")).rejects.toThrow("moyasar_payment_id_invalid");
  });
});
