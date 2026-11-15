/**
 * CSRF guard for mutating POST routes (the cookies are also SameSite=Lax). An Origin header must parse and match
 * our host ("null" and malformed values are rejected, never thrown on); with no Origin, the browser must say
 * Sec-Fetch-Site: same-origin or same-site. Neither header = refused.
 */
export function isSameSiteRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    try {
      const host = req.headers.get("host") ?? new URL(req.url).host;
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = req.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "same-site";
}
