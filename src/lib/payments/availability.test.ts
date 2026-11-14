import { describe, expect, it } from "vitest";
import { depositPaymentsBlocked, paymentsAvailableFor, tenantRequiresDeposit } from "./availability";

const demo = { is_demo: true };
const real = { is_demo: false };

describe("paymentsAvailableFor", () => {
  it("production (Vercel) without any key: unavailable", () => {
    expect(paymentsAvailableFor(real, { NODE_ENV: "production", VERCEL_ENV: "production" })).toBe(false);
    expect(paymentsAvailableFor(demo, { NODE_ENV: "production", VERCEL_ENV: "production" })).toBe(false);
  });
  it("production with a Moyasar key: available for any tenant", () => {
    const env = { NODE_ENV: "production", VERCEL_ENV: "production", MOYASAR_SECRET_KEY: "sk_test_x" };
    expect(paymentsAvailableFor(real, env)).toBe(true);
    expect(paymentsAvailableFor(demo, env)).toBe(true);
  });
  it("production with PAYMENT_PROVIDER=moyasar but no key: unavailable", () => {
    expect(paymentsAvailableFor(real, { NODE_ENV: "production", PAYMENT_PROVIDER: "moyasar" })).toBe(false);
  });
  it("dev with the fake provider: available for a demo tenant only", () => {
    const env = { NODE_ENV: "development", PAYMENT_PROVIDER: "fake" };
    expect(paymentsAvailableFor(demo, env)).toBe(true);
    expect(paymentsAvailableFor(real, env)).toBe(false); // non-demo tenant with fake
  });
  it("fake is never allowed on Vercel production, nor in a production build without the opt-in", () => {
    expect(paymentsAvailableFor(demo, { NODE_ENV: "production", VERCEL_ENV: "production", PAYMENT_PROVIDER: "fake", ALLOW_FAKE_PAYMENTS: "true" })).toBe(false);
    expect(paymentsAvailableFor(demo, { NODE_ENV: "production", PAYMENT_PROVIDER: "fake" })).toBe(false);
    expect(paymentsAvailableFor(demo, { NODE_ENV: "production", PAYMENT_PROVIDER: "fake", ALLOW_FAKE_PAYMENTS: "true" })).toBe(true);
  });
  it("nothing configured in dev: unavailable (fake is never implicit)", () => {
    expect(paymentsAvailableFor(demo, { NODE_ENV: "development" })).toBe(false);
  });
});

describe("depositPaymentsBlocked", () => {
  it("blocks a deposit tenant without a provider, never a no-deposit tenant", () => {
    const env = { NODE_ENV: "production", VERCEL_ENV: "production" };
    expect(depositPaymentsBlocked({ ...real, deposit_enabled: true }, env)).toBe(true);
    expect(depositPaymentsBlocked({ ...demo, deposit_enabled: true }, env)).toBe(true);
    expect(depositPaymentsBlocked({ ...real, deposit_enabled: false }, env)).toBe(false);
  });
  it("does not block when a provider is usable", () => {
    expect(depositPaymentsBlocked({ ...real, deposit_enabled: true }, { NODE_ENV: "production", MOYASAR_SECRET_KEY: "sk_test_x" })).toBe(false);
    expect(depositPaymentsBlocked({ ...demo, deposit_enabled: true }, { NODE_ENV: "development", PAYMENT_PROVIDER: "fake" })).toBe(false);
  });
  it("blocks a non-demo deposit tenant when only the fake provider is configured", () => {
    expect(depositPaymentsBlocked({ ...real, deposit_enabled: true }, { NODE_ENV: "development", PAYMENT_PROVIDER: "fake" })).toBe(true);
  });
  it("tenantRequiresDeposit follows deposit_enabled", () => {
    expect(tenantRequiresDeposit({ deposit_enabled: true })).toBe(true);
    expect(tenantRequiresDeposit({ deposit_enabled: false })).toBe(false);
  });
});
