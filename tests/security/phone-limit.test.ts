import { describe, expect, it } from "vitest";
import { dbPhone, phoneBookingAllowed, phoneBookingKey } from "@/lib/security/phone-limit";

describe("per-phone booking key (L4)", () => {
  it("normalises like the database (strips spaces, dashes, parentheses) and hashes", () => {
    expect(dbPhone("+966 (50) 123-4567")).toBe("+966501234567");
    const a = phoneBookingKey("t1", "+966 50 123 4567");
    expect(a).toBe(phoneBookingKey("t1", "+966501234567"));
    expect(a).not.toBe(phoneBookingKey("t2", "+966501234567"));
    expect(a).not.toBe(phoneBookingKey("t1", "+966501234568"));
    expect(a).toMatch(/^book-phone:t1:[0-9a-f]{64}$/);
  });

  it("asks check_rate_limit for 3 per day, fails closed when the limiter errors", async () => {
    const calls: unknown[] = [];
    const db = (r: { data: unknown; error: { message: string } | null }) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => (calls.push([fn, args]), r),
    });
    expect(await phoneBookingAllowed(db({ data: true, error: null }), "t", "+966501234567")).toBe(true);
    expect(await phoneBookingAllowed(db({ data: false, error: null }), "t", "+966501234567")).toBe(false);
    expect(calls[0]).toEqual(["check_rate_limit", { p_key: phoneBookingKey("t", "+966501234567"), p_max: 3, p_window: "1 day" }]);
    await expect(phoneBookingAllowed(db({ data: null, error: { message: "boom" } }), "t", "+966501234567")).rejects.toBeTruthy();
  });
});
