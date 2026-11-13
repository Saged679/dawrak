import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "T".repeat(48);
const state = vi.hoisted(() => ({ view: null as Record<string, unknown> | null, processed: 0 }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`REDIRECT:${to}`), { digest: `NEXT_REDIRECT;replace;${to}` });
  },
  notFound: () => {
    throw Object.assign(new Error("NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  },
}));
vi.mock("@/lib/db/public", () => ({ rateLimitOk: async () => true }));
vi.mock("@/lib/payments/process", () => ({
  processPaymentEvent: async () => {
    state.processed++;
    return { kind: "settled", outcome: "confirmed" };
  },
}));
vi.mock("@/lib/payments/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/store")>()),
  loadPaymentView: async () => state.view,
  saveCheckout: async () => {},
  supabasePaymentStore: () => ({}),
}));

import { simulateFakePayment, startPayment } from "./actions";

const base = `/en/c/clinic/pay/${TOKEN}`;
const view = (over: Record<string, unknown> = {}) => ({
  paymentId: "p1",
  token: TOKEN,
  status: "pending",
  provider: "moyasar",
  amountMinor: 5000,
  currency: "SAR",
  checkoutUrl: "https://checkout.moyasar.com/i/1",
  providerRef: "inv_1",
  tenant: { id: "t", slug: "clinic", name_ar: "ع", name_en: "C", timezone: "Asia/Riyadh", brand_color: null, is_demo: false },
  appointment: { id: "a", status: "pending_payment", startsAt: "2030-01-01T10:00:00Z", paymentExpiresAt: new Date(Date.now() + 600_000).toISOString(), serviceNameAr: "", serviceNameEn: null },
  ...over,
});
const form = () => {
  const fd = new FormData();
  fd.set("token", TOKEN);
  fd.set("slug", "clinic");
  fd.set("locale", "en");
  fd.set("outcome", "paid");
  return fd;
};
const redirectOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return "no redirect";
};

describe("startPayment redirect validation", () => {
  beforeEach(() => {
    vi.stubEnv("PAYMENT_PROVIDER", "moyasar");
    vi.stubEnv("MOYASAR_SECRET_KEY", "sk_test_x");
    vi.stubEnv("NODE_ENV", "test");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("redirects to a genuine moyasar checkout", async () => {
    state.view = view();
    expect(await redirectOf(startPayment(form()))).toBe("REDIRECT:https://checkout.moyasar.com/i/1");
  });
  it.each([
    "https://evilmoyasar.com/i/1",
    "https://moyasar.com.evil.test/i/1",
    "http://checkout.moyasar.com/i/1",
    "https://user:pw@moyasar.com/i/1",
    "https://evil.test/",
    "javascript:alert(1)",
  ])("never redirects to %s: falls back to the existing ?error=start flow", async (url) => {
    state.view = view({ checkoutUrl: url });
    expect(await redirectOf(startPayment(form()))).toBe(`REDIRECT:${base}?error=start`);
  });
});

describe("fake provider is demo-tenant only", () => {
  beforeEach(() => {
    vi.stubEnv("PAYMENT_PROVIDER", "fake");
    vi.stubEnv("NODE_ENV", "test");
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.processed = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const fakeView = (isDemo: boolean) =>
    view({ provider: "fake", checkoutUrl: `${base}/fake`, tenant: { ...view().tenant, is_demo: isDemo } });

  it("startPayment: demo tenant goes to the exact internal fake page", async () => {
    state.view = fakeView(true);
    expect(await redirectOf(startPayment(form()))).toBe(`REDIRECT:${base}/fake`);
  });
  it("startPayment: a non-demo tenant gets ?error=start, never the fake page", async () => {
    state.view = fakeView(false);
    expect(await redirectOf(startPayment(form()))).toBe(`REDIRECT:${base}?error=start`);
  });
  it("startPayment: a fake checkout URL pointing anywhere else is refused", async () => {
    state.view = { ...fakeView(true), checkoutUrl: "https://evil.test/" };
    expect(await redirectOf(startPayment(form()))).toBe(`REDIRECT:${base}?error=start`);
  });
  it("simulateFakePayment: 404 for a non-demo tenant, settles for a demo one", async () => {
    state.view = fakeView(false);
    expect(await redirectOf(simulateFakePayment(form()))).toBe("NOT_FOUND");
    expect(state.processed).toBe(0);
    state.view = fakeView(true);
    expect(await redirectOf(simulateFakePayment(form()))).toBe(`REDIRECT:${base}/result`);
    expect(state.processed).toBe(1);
  });
  it("simulateFakePayment: 404 when the fake provider is not explicitly enabled", async () => {
    vi.stubEnv("PAYMENT_PROVIDER", "");
    vi.stubEnv("DEMO_MODE", "true");
    state.view = fakeView(true);
    expect(await redirectOf(simulateFakePayment(form()))).toBe("NOT_FOUND");
    expect(state.processed).toBe(0);
  });
});
