import { createHash } from "node:crypto";

/** The phone as the database keys customers: create_public_booking strips whitespace, dashes and parentheses. */
export const dbPhone = (p: string) => p.replace(/[\s\-()]/g, "");

/** Max booking attempts per phone number per tenant per day (L4), on top of the per-IP limit. */
export const PHONE_BOOKING_LIMIT = { max: 3, window: "1 day" } as const;

/** Key of the per-phone bucket. Only a hash of the number is stored in rate_limits. */
export function phoneBookingKey(tenantId: string, phone: string): string {
  return `book-phone:${tenantId}:${createHash("sha256").update(dbPhone(phone)).digest("hex")}`;
}

type RpcDb = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }> };

/** True while this phone is inside its daily limit. Throws when the limiter itself fails (callers fail closed). */
export async function phoneBookingAllowed(db: RpcDb, tenantId: string, phone: string): Promise<boolean> {
  const { data, error } = await db.rpc("check_rate_limit", {
    p_key: phoneBookingKey(tenantId, phone),
    p_max: PHONE_BOOKING_LIMIT.max,
    p_window: PHONE_BOOKING_LIMIT.window,
  });
  if (error) throw error;
  return data === true;
}
