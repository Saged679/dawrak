/** Pure patient-page rules (no I/O) so the server actions and the tests share them. */

/** Customers may cancel or move an appointment until this many hours before it starts. */
export const CANCEL_WINDOW_HOURS = 2;

/** Slots offered when rescheduling (same horizon as the public booking page). */
export const RESCHEDULE_WINDOW_DAYS = 14;

/** The token is 24 random bytes as lowercase hex (customers.access_token). Cheap shape check. */
export function isCustomerToken(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{48}$/.test(v);
}

export function isSafeSlug(v: unknown): v is string {
  return typeof v === "string" && v.length <= 60 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v);
}

/** True while the appointment is far enough away to be changed by the customer. */
export function withinChangeWindow(startsAt: string | Date, now: Date = new Date()): boolean {
  const start = typeof startsAt === "string" ? new Date(startsAt) : startsAt;
  return start.getTime() - now.getTime() >= CANCEL_WINDOW_HOURS * 3_600_000;
}

export type ChangeableStatus = "pending_payment" | "confirmed";

export function canChange(status: string, startsAt: string, now: Date = new Date()): boolean {
  return (status === "pending_payment" || status === "confirmed") && withinChangeWindow(startsAt, now);
}
