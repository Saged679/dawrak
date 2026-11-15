/** Origin of the default test server (playwright.config.ts: E2E_PORT, default 3000). */
export const SITE = `http://localhost:${process.env.E2E_PORT ?? "3000"}`;

/**
 * Headers that give one test its own rate-limit bucket (the servers trust X-Forwarded-For, see TRUSTED_PROXY_HEADER in
 * playwright.config.ts). Without it every spec shares one IP, and the per-IP chat limits (20 per 10 minutes, 60 per day)
 * make chat specs that run in parallel fail at random.
 */
export function ownIpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const n = () => 1 + Math.floor(Math.random() * 254);
  return { "x-forwarded-for": `10.${n()}.${n()}.${n()}`, ...extra };
}
