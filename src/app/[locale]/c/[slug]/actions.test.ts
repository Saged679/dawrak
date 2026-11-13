import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createBooking = vi.fn();
const tenantRow = vi.hoisted(() => ({ v: { id: "t1", slug: "demo", is_demo: false, deposit_type: "fixed", deposit_value: 50 } as Record<string, unknown> }));
const created = vi.hoisted(() => ({ v: [] as unknown[] }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/payments/store", () => ({
  createPendingPayment: async (a: unknown) => {
    created.v.push(a);
    return "T".repeat(48);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
const afterCbs = vi.hoisted(() => ({ v: [] as (() => Promise<void> | void)[] }));
const sendBookingEmail = vi.hoisted(() => vi.fn());
const attachDemoSession = vi.hoisted(() => vi.fn());
vi.mock("next/server", () => ({ after: (cb: () => Promise<void> | void) => void afterCbs.v.push(cb) }));
vi.mock("@/lib/customer/emails", () => ({ sendBookingEmail: (...a: unknown[]) => sendBookingEmail(...a) }));
vi.mock("@/lib/demo/session", () => ({ ensureDemoSessionHash: async () => "d".repeat(64) }));
vi.mock("@/lib/db/public", () => ({
  createBooking: (...a: unknown[]) => createBooking(...a),
  getSlots: vi.fn(),
  attachDemoSession: (...a: unknown[]) => attachDemoSession(...a),
  getTenantBySlug: async () => tenantRow.v,
  rateLimitOk: async () => true,
}));

import { submitBooking } from "./actions";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("submitBooking", () => {
  beforeEach(() => {
    createBooking.mockReset();
    sendBookingEmail.mockReset();
    attachDemoSession.mockReset();
    afterCbs.v = [];
  });

  it("never returns a customer token or access token to the browser", async () => {
    // Even if the DB layer leaked one, the action must not forward it as a field.
    createBooking.mockResolvedValue({
      ok: true,
      booking: {
        appointmentId: UUID,
        status: "confirmed",
        startsAt: "2030-01-01T10:00:00Z",
        endsAt: "2030-01-01T10:30:00Z",
        price: 100,
        depositAmount: 0,
        currency: "SAR",
      },
    });
    const fd = new FormData();
    fd.set("slug", "demo");
    fd.set("locale", "en");
    fd.set("serviceId", UUID);
    fd.set("providerId", UUID);
    fd.set("startsAt", "2030-01-01T10:00:00Z");
    fd.set("fullName", "Test User");
    fd.set("phone", "+966501234567");
    const res = await submitBooking({ status: "idle" } as never, fd);
    expect(res.status).toBe("success");
    expect(JSON.stringify(res)).not.toMatch(/token/i);
  });

  describe("brand-new customer (the database hands out a token)", () => {
    const TOKEN = "ab".repeat(24);
    const ok = (status: "confirmed" | "pending_payment" = "confirmed") => ({
      ok: true,
      booking: { appointmentId: UUID, status, startsAt: "2030-01-01T10:00:00Z", endsAt: "2030-01-01T10:30:00Z", price: 100, depositAmount: 0, currency: "SAR" },
      customerToken: TOKEN,
    });
    const form = (email = "new@example.com") => {
      const fd = new FormData();
      for (const [k, v] of Object.entries({ slug: "demo", locale: "en", serviceId: UUID, providerId: UUID, startsAt: "2030-01-01T10:00:00Z", fullName: "Test User", phone: "+966501234567", email })) fd.set(k, v);
      return fd;
    };
    beforeEach(() => {
      tenantRow.v = { id: "t1", slug: "demo", is_demo: false, deposit_type: "fixed", deposit_value: 50 };
    });

    it("redirects server-side to the patient page; the token is never in a returned value", async () => {
      createBooking.mockResolvedValue(ok());
      await expect(submitBooking({ status: "idle" } as never, form())).rejects.toThrow(`REDIRECT:/en/c/demo/my/${TOKEN}?booked=${UUID}`);
    });
    it("queues the booking e-mail to the typed address after the response, with the token", async () => {
      createBooking.mockResolvedValue(ok());
      await expect(submitBooking({ status: "idle" } as never, form())).rejects.toThrow(/REDIRECT/);
      expect(sendBookingEmail).not.toHaveBeenCalled();
      for (const cb of afterCbs.v) await cb();
      expect(sendBookingEmail).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN, email: "new@example.com", appointmentId: UUID, sessionHash: null }));
    });
    it("without an e-mail address there is no mail, but the redirect still happens", async () => {
      createBooking.mockResolvedValue(ok());
      await expect(submitBooking({ status: "idle" } as never, form(""))).rejects.toThrow(/REDIRECT/);
      expect(afterCbs.v).toHaveLength(0);
    });
    it("a demo tenant binds the booking to the visitor session and mails their own outbox", async () => {
      tenantRow.v = { id: "t1", slug: "demo", is_demo: true, deposit_type: "fixed", deposit_value: 0 };
      createBooking.mockResolvedValue(ok());
      await expect(submitBooking({ status: "idle" } as never, form())).rejects.toThrow(/REDIRECT/);
      expect(attachDemoSession).toHaveBeenCalledWith("t1", UUID, "d".repeat(64));
      for (const cb of afterCbs.v) await cb();
      expect(sendBookingEmail).toHaveBeenCalledWith(expect.objectContaining({ sessionHash: "d".repeat(64) }));
    });
    it("an EXISTING customer (no token) stays on the booking page and gets no link", async () => {
      createBooking.mockResolvedValue({ ...ok(), customerToken: null });
      const res = await submitBooking({ status: "idle" } as never, form());
      expect(res.status).toBe("success");
      expect(JSON.stringify(res)).not.toMatch(/token/i);
      expect(afterCbs.v).toHaveLength(0);
    });
  });

  describe("deposit tenant provider gating", () => {
    const held = {
      ok: true,
      booking: { appointmentId: UUID, status: "pending_payment", startsAt: "2030-01-01T10:00:00Z", endsAt: "2030-01-01T10:30:00Z", price: 100, depositAmount: 50, currency: "SAR" },
    };
    const form = () => {
      const fd = new FormData();
      for (const [k, v] of Object.entries({ slug: "demo", locale: "en", serviceId: UUID, providerId: UUID, startsAt: "2030-01-01T10:00:00Z", fullName: "Test User", phone: "+966501234567" })) fd.set(k, v);
      return fd;
    };
    beforeEach(() => {
      created.v = [];
      createBooking.mockResolvedValue(held);
      vi.stubEnv("PAYMENT_PROVIDER", "fake");
      vi.stubEnv("NODE_ENV", "test");
    });
    afterEach(() => vi.unstubAllEnvs());

    it("a non-demo tenant never gets a fake payment: no payment row, no redirect", async () => {
      tenantRow.v = { id: "t1", slug: "demo", is_demo: false, deposit_type: "fixed", deposit_value: 50 };
      const res = await submitBooking({ status: "idle" } as never, form());
      expect(res.status).toBe("success");
      expect(created.v).toHaveLength(0);
    });
    it("a demo tenant gets the fake payment and is redirected to its pay page", async () => {
      tenantRow.v = { id: "t1", slug: "demo", is_demo: true, deposit_type: "fixed", deposit_value: 50 };
      await expect(submitBooking({ status: "idle" } as never, form())).rejects.toThrow(`REDIRECT:/en/c/demo/pay/${"T".repeat(48)}`);
      expect(created.v).toMatchObject([{ tenantId: "t1", amountMinor: 5000, provider: "fake" }]);
    });
  });
});

describe("submitBooking per-phone daily limit (L4)", () => {
  it("is checked with the hashed per-tenant/phone key BEFORE the booking is created, and refuses when over", async () => {
    const calls: string[] = [];
    const limiter = await import("@/lib/db/public");
    const spy = vi.spyOn(limiter, "rateLimitOk").mockImplementation(async (key: string) => {
      calls.push(key);
      return !key.startsWith("book-phone:");
    });
    createBooking.mockReset();
    const fd = new FormData();
    for (const [k, v] of Object.entries({ slug: "demo", locale: "en", serviceId: UUID, providerId: UUID, startsAt: "2030-01-01T10:00:00Z", fullName: "Test User", phone: "+966501234567" })) fd.set(k, v);
    tenantRow.v = { id: "t1", slug: "demo", is_demo: false };
    const res = await submitBooking({ status: "idle" } as never, fd);
    expect(res).toEqual({ status: "error", code: "phone_limit" });
    expect(createBooking).not.toHaveBeenCalled();
    expect(calls.some((k) => /^book-phone:t1:[0-9a-f]{64}$/.test(k))).toBe(true);
    spy.mockRestore();
  });
});
