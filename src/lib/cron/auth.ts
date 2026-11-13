import { createHash, timingSafeEqual } from "node:crypto";

const sha = (v: string) => createHash("sha256").update(v).digest();

/**
 * Bearer-secret check for the cron endpoint. Fails closed: with no (or a short) CRON_SECRET nothing is
 * ever authorised. Both sides are hashed first so the comparison is constant time whatever the length.
 */
export function isAuthorizedCron(authHeader: string | null, secret: string | undefined = process.env.CRON_SECRET): boolean {
  if (!secret || secret.length < 16) return false;
  if (!authHeader) return false;
  const m = /^Bearer (.+)$/.exec(authHeader);
  if (!m) return false;
  return timingSafeEqual(sha(m[1]), sha(secret));
}
