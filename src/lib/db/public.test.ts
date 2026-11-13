import { describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("./client", () => ({ getServiceClient: () => ({ rpc }) }));

import { createBooking } from "./public";

describe("createBooking", () => {
  it("keeps customer_token out of the booking object; it is only a separate server-side field", async () => {
    rpc.mockResolvedValue({
      error: null,
      data: {
        appointment_id: "a1", status: "confirmed", starts_at: "s", ends_at: "e",
        price: 10, deposit_amount: 0, currency: "SAR", customer_token: "SECRET-TOKEN",
      },
    });
    const r = await createBooking("t1", { providerId: "p", serviceId: "s", startsAt: "x", fullName: "n", phone: "1", locale: "en" } as never);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(JSON.stringify(r.booking)).not.toMatch(/token/i);
    expect(r.customerToken).toBe("SECRET-TOKEN");
  });

  it("has no token for an existing customer", async () => {
    rpc.mockResolvedValue({
      error: null,
      data: { appointment_id: "a1", status: "confirmed", starts_at: "s", ends_at: "e", price: 10, deposit_amount: 0, currency: "SAR", customer_token: null },
    });
    const r = await createBooking("t1", { providerId: "p", serviceId: "s", startsAt: "x", fullName: "n", phone: "1", locale: "en" } as never);
    expect(r.ok && r.customerToken).toBeNull();
  });
});
