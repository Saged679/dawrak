import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const load = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({ getServiceClient: () => ({ rpc }) }));
vi.mock("@/lib/mail", () => ({ mailProviderFor: () => ({ name: "resend", send }) }));
vi.mock("@/lib/customer/portal", () => ({ loadPortal: (...a: unknown[]) => load(...a) }));

import { BOOKING_MAIL_LIMIT, bookingMailKey, normalizeRecipient, sendBookingEmail } from "@/lib/customer/emails";
import { createBooking } from "@/lib/db/public";

const APPT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const portal = {
  tenant: { name_ar: "ع", name_en: "Clinic", timezone: "Asia/Riyadh" },
  fullName: "Sara",
  appointments: [
    { id: APPT, serviceNameAr: "خ", serviceNameEn: "Svc", providerNameAr: "ط", providerNameEn: "Dr", startsAt: "2030-01-01T09:00:00Z", status: "confirmed" },
  ],
};
const real = { id: "t-real", slug: "real", is_demo: false };
const demo = { id: "t-demo", slug: "demo-clinic", is_demo: true };
const args = (tenant: typeof real, email = "Victim@Example.com") => ({ tenant, token: "t".repeat(48), appointmentId: APPT, email, locale: "en" as const, sessionHash: null });

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: true, error: null });
  send.mockReset().mockResolvedValue({ id: null });
  load.mockReset().mockResolvedValue(portal);
});

describe("L6: booking mails per recipient address", () => {
  it("the cap is 3 a day and the key is a hash of the lower-cased address (the address is never stored)", () => {
    expect(BOOKING_MAIL_LIMIT).toEqual({ max: 3, window: "1 day" });
    expect(bookingMailKey("Victim@Example.com")).toBe(bookingMailKey(" victim@example.com "));
    expect(bookingMailKey("a@example.com")).not.toBe(bookingMailKey("b@example.com"));
    expect(bookingMailKey("victim@example.com")).toMatch(/^mail:[0-9a-f]{32}:booking$/);
    expect(bookingMailKey("victim@example.com")).not.toContain("victim");
  });
  it("sends while inside the cap and checks the recipient bucket first", async () => {
    await sendBookingEmail(args(real));
    expect(rpc).toHaveBeenCalledWith("check_rate_limit", { p_key: bookingMailKey("victim@example.com"), p_max: 3, p_window: "1 day" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("L7: +tags, Gmail dots and googlemail.com all share one cap key", () => {
    const k = bookingMailKey("victim@gmail.com");
    for (const e of ["v.i.c.t.i.m@gmail.com", "victim+spam1@gmail.com", "Victim+x@googlemail.com", "VICTIM@GMAIL.COM"]) expect(bookingMailKey(e), e).toBe(k);
    expect(normalizeRecipient("a.b+c@corp.example")).toBe("a.b@corp.example"); // dots only collapse on Gmail
    expect(bookingMailKey("a.b@corp.example")).not.toBe(bookingMailKey("ab@corp.example"));
  });
  it("L7: nothing is counted when there is nothing to send (booking not found in the portal)", async () => {
    load.mockResolvedValue(null);
    await sendBookingEmail(args(real));
    expect(rpc).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("drops the mail silently once the recipient is over the cap (no send)", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(sendBookingEmail(args(real))).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it("demo mail (database outbox, own per-visitor caps) is not counted against the address", async () => {
    await sendBookingEmail({ ...args(demo as never), sessionHash: "a".repeat(64) });
    expect(rpc).not.toHaveBeenCalledWith("check_rate_limit", expect.anything());
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("M2: web booking carries the visitor session as owner", () => {
  const input = { serviceId: "s", providerId: "p", startsAt: "2030-01-01T06:00:00Z", fullName: "Sara Test", phone: "0512345678", email: undefined, locale: "ar" } as never;
  it("passes p_session_hash to create_public_booking", async () => {
    rpc.mockResolvedValue({ data: { appointment_id: APPT, status: "confirmed", starts_at: "x", ends_at: "y", price: 1, currency: "SAR" }, error: null });
    const hash = "f".repeat(64);
    await createBooking("t-demo", input, hash);
    expect(rpc).toHaveBeenCalledWith("create_public_booking", expect.objectContaining({ p_tenant_id: "t-demo", p_session_hash: hash }));
    await createBooking("t-real", input);
    expect(rpc).toHaveBeenLastCalledWith("create_public_booking", expect.objectContaining({ p_session_hash: null }));
  });
});
