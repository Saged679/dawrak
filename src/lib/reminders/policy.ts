/** Retry policy for the reminder dispatcher (pure, shared with the tests). */

/** A reminder is tried at most this many times (claims), then it is marked failed for good. */
export const MAX_ATTEMPTS = 4;

/** Minutes to wait before the next try after `attempts` tries have failed: 5, 15, 45, ... capped at 6 h. */
export function retryDelayMinutes(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(5 * 3 ** (n - 1), 360);
}
