import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { derivePayState, loadPaymentView, type PaymentView } from "./store";
import { isPaymentToken, newPaymentToken } from "./tokens";
import { resolveProvider, providerForTenant, PaymentsUnavailableError } from "./index";
import { WebhookAuthError } from "./types";

type Row = Record<string, unknown>;
/** Tiny chainable stand-in for the Supabase query builder: from().select().eq()....maybeSingle(). */
function stubClient(tables: Record<string, Row[]>) {
  const queried: string[] = [];
  const client = {
    from(table: string) {
      queried.push(table);
      const filters: [string, unknown][] = [];
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => (filters.push([k, v]), b),
        maybeSingle: async () => ({
          data: (tables[table] ?? []).find((r) => filters.every(([k, v]) => r[k] === v)) ?? null,
          error: null,
        }),
      };
      return b;
    },
  };
  return { client: client as unknown as SupabaseClient, queried };
}

const TOKEN = newPaymentToken();
const tables = (): Record<string, Row[]> => ({
  payments: [
    { id: "pay-1", tenant_id: "ten-a", appointment_id: "ap-1", status: "pending", provider: "fake", provider_ref: "r", amount: "50.00", currency: "SAR", checkout_url: null, public_token: TOKEN },
  ],
  tenants: [
    { id: "ten-a", slug: "clinic-a", name_ar: "أ", name_en: "A", timezone: "Asia/Riyadh", brand_color: null, is_demo: false },
    { id: "ten-b", slug: "clinic-b", name_ar: "ب", name_en: "B", timezone: "Asia/Riyadh", brand_color: null, is_demo: false },
  ],
  appointments: [{ id: "ap-1", tenant_id: "ten-a", status: "pending_payment", starts_at: "2030-01-01T10:00:00Z", payment_expires_at: "2030-01-01T09:00:00Z", service_id: "sv-1" }],
  services: [{ id: "sv-1", tenant_id: "ten-a", name_ar: "كشف", name_en: "Check-up" }],
});

describe("payment page access control", () => {
  it("tokens are 48 url-safe random chars and never repeat", () => {
    const a = newPaymentToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{48}$/);
    expect(isPaymentToken(a)).toBe(true);
    expect(newPaymentToken()).not.toBe(a);
  });

  it("rejects malformed tokens without touching the database", async () => {
    const { client, queried } = stubClient(tables());
    for (const bad of ["", "1", "12345678-1234-4234-8234-123456789012", "a".repeat(39), "../../x" + "a".repeat(40), "a b".repeat(20)]) {
      expect(await loadPaymentView(bad, "clinic-a", client)).toBeNull();
    }
    expect(queried).toEqual([]);
  });

  it("an unknown (guessed) token is a 404", async () => {
    const { client } = stubClient(tables());
    expect(await loadPaymentView(newPaymentToken(), "clinic-a", client)).toBeNull();
  });

  it("a valid token under ANOTHER tenant's slug is a 404 (no cross-tenant exposure)", async () => {
    const { client } = stubClient(tables());
    expect(await loadPaymentView(TOKEN, "clinic-b", client)).toBeNull();
    expect(await loadPaymentView(TOKEN, "nope", client)).toBeNull();
  });

  it("the right token and slug loads; amount comes from the row in minor units", async () => {
    const { client } = stubClient(tables());
    const v = await loadPaymentView(TOKEN, "clinic-a", client);
    expect(v?.amountMinor).toBe(5000);
    expect(v?.tenant.slug).toBe("clinic-a");
    expect(JSON.stringify(v)).not.toContain("access_token");
  });
});

describe("derivePayState (server state + server clock only)", () => {
  const base = (over: Partial<PaymentView> = {}, appt: Partial<PaymentView["appointment"]> = {}): PaymentView => ({
    paymentId: "p", token: TOKEN, status: "pending", provider: "fake", amountMinor: 5000, currency: "SAR", checkoutUrl: null, providerRef: "r",
    tenant: { id: "t", slug: "s", name_ar: "", name_en: null, timezone: "Asia/Riyadh", brand_color: null, is_demo: false },
    appointment: { id: "a", status: "pending_payment", startsAt: "2030-01-01T10:00:00Z", paymentExpiresAt: "2030-01-01T09:15:00Z", serviceNameAr: "", serviceNameEn: null, ...appt },
    ...over,
  });
  const before = new Date("2030-01-01T09:00:00Z");
  const after = new Date("2030-01-01T09:15:01Z");

  it("awaiting inside the hold, expired after it (even before the cron cancels the row)", () => {
    expect(derivePayState(base(), before)).toBe("awaiting");
    expect(derivePayState(base(), after)).toBe("expired");
  });
  it("failed payment keeps the hold, retry allowed until expiry", () => {
    expect(derivePayState(base({ status: "failed" }), before)).toBe("failed");
    expect(derivePayState(base({ status: "failed" }), after)).toBe("expired");
  });
  it("paid / confirmed show as paid; refund_due is its own plain state", () => {
    expect(derivePayState(base({ status: "paid" }, { status: "confirmed" }), after)).toBe("paid");
    expect(derivePayState(base({}, { status: "confirmed" }), after)).toBe("paid");
    expect(derivePayState(base({ status: "refund_due" }, { status: "cancelled" }), after)).toBe("refund_due");
    expect(derivePayState(base({}, { status: "cancelled" }), before)).toBe("expired");
  });
});

describe("provider factory", () => {
  it("fake only on an explicit PAYMENT_PROVIDER=fake; moyasar needs a key; nothing configured is unavailable", () => {
    expect(resolveProvider({ PAYMENT_PROVIDER: "fake" }).name).toBe("fake");
    expect(() => resolveProvider({ PAYMENT_PROVIDER: "moyasar" })).toThrow(PaymentsUnavailableError);
    expect(resolveProvider({ PAYMENT_PROVIDER: "moyasar", MOYASAR_SECRET_KEY: "sk_test_x" }).name).toBe("moyasar");
    expect(resolveProvider({ MOYASAR_SECRET_KEY: "sk_test_x" }).name).toBe("moyasar");
    expect(() => resolveProvider({})).toThrow(PaymentsUnavailableError);
  });

  it("DEMO_MODE never selects the fake provider (the old implicit fallback is gone)", () => {
    const env = { DEMO_MODE: "true" } as Parameters<typeof resolveProvider>[0];
    expect(() => resolveProvider(env)).toThrow(PaymentsUnavailableError);
    expect(() => resolveProvider({ ...env, PAYMENT_PROVIDER: "" })).toThrow(PaymentsUnavailableError);
  });

  it("production without a Moyasar key refuses, with a clear message", () => {
    for (const env of [{ VERCEL_ENV: "production" }, { NODE_ENV: "production" }]) {
      expect(() => resolveProvider(env)).toThrow(/MOYASAR_SECRET_KEY is not set/);
      expect(() => resolveProvider({ ...env, PAYMENT_PROVIDER: "moyasar" })).toThrow(PaymentsUnavailableError);
    }
    expect(resolveProvider({ VERCEL_ENV: "production", MOYASAR_SECRET_KEY: "sk_live_x" }).name).toBe("moyasar");
  });

  it("fake is refused on a Vercel production deployment even with the opt-in, and in a production build without it", () => {
    expect(() => resolveProvider({ PAYMENT_PROVIDER: "fake", VERCEL_ENV: "production" })).toThrow(/production deployment/);
    expect(() =>
      resolveProvider({ PAYMENT_PROVIDER: "fake", VERCEL_ENV: "production", NODE_ENV: "production", ALLOW_FAKE_PAYMENTS: "true" }),
    ).toThrow(PaymentsUnavailableError);
    expect(() => resolveProvider({ PAYMENT_PROVIDER: "fake", NODE_ENV: "production" })).toThrow(/ALLOW_FAKE_PAYMENTS/);
    expect(
      resolveProvider({ PAYMENT_PROVIDER: "fake", NODE_ENV: "production", ALLOW_FAKE_PAYMENTS: "true" }).name,
    ).toBe("fake");
  });

  it("a non-demo tenant never gets the fake provider; a demo tenant does", () => {
    const env = { PAYMENT_PROVIDER: "fake" };
    expect(() => providerForTenant({ is_demo: false }, env)).toThrow(/demo/);
    expect(providerForTenant({ is_demo: true }, env).name).toBe("fake");
    const real = { PAYMENT_PROVIDER: "moyasar", MOYASAR_SECRET_KEY: "sk_test_x" };
    expect(providerForTenant({ is_demo: false }, real).name).toBe("moyasar");
  });

  it("a forged fake webhook is rejected: no default secret, the old public constant is dead", () => {
    const forged = JSON.stringify({
      id: "evt_1",
      type: "payment_paid",
      secret_token: "dawrak-fake-webhook-secret",
      data: { id: "fake_paid_5000_SAR_fakeinv_x", invoice_id: "fakeinv_x" },
    });
    // fake explicitly enabled but no FAKE_WEBHOOK_SECRET configured
    expect(() => resolveProvider({ PAYMENT_PROVIDER: "fake" }).verifyAndParseWebhook(forged)).toThrow(WebhookAuthError);
    // MOYASAR_WEBHOOK_SECRET is not borrowed for the fake provider either
    expect(() =>
      resolveProvider({ PAYMENT_PROVIDER: "fake", MOYASAR_WEBHOOK_SECRET: "dawrak-fake-webhook-secret" }).verifyAndParseWebhook(forged),
    ).toThrow(WebhookAuthError);
    // with an explicit secret only that secret works
    const p = resolveProvider({ PAYMENT_PROVIDER: "fake", FAKE_WEBHOOK_SECRET: "s3cret-value" });
    expect(() => p.verifyAndParseWebhook(forged)).toThrow(WebhookAuthError);
    expect(p.verifyAndParseWebhook(forged.replace("dawrak-fake-webhook-secret", "s3cret-value")).eventId).toBe("evt_1");
    // and with fake not enabled there is no provider to verify against at all
    expect(() => resolveProvider({ DEMO_MODE: "true" } as never)).toThrow(PaymentsUnavailableError);
  });
  it("silences unused import lint", () => expect(vi).toBeDefined());
});
