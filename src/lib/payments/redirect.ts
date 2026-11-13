/**
 * Defence in depth for the post-"Pay deposit" redirect. The stored checkout URL comes from the
 * provider (or the database), so it is validated again right before redirecting:
 *  - moyasar: an https URL (no credentials) whose host is moyasar.com or a subdomain of it;
 *    lookalikes (evilmoyasar.com, moyasar.com.evil.test) fail because the match is on whole labels.
 *  - fake: only the exact internal fake checkout path of this very payment.
 */
export function isSafeCheckoutTarget(
  url: string,
  provider: string,
  fakePath: string,
): boolean {
  if (provider === "fake") return url === fakePath;
  if (provider !== "moyasar") return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return host === "moyasar.com" || host.endsWith(".moyasar.com");
}
