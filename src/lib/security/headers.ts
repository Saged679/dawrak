/**
 * Security headers for next.config.ts (pure, no Next imports).
 *
 * CSP choice: static enforced policy, no per-request nonce. Next docs recommend a nonce, but it
 * needs every page rendered dynamically (proxy nonce + headers()/connection() in the root layout)
 * and the locale home pages are statically generated. Experimental SRI was tried and does not
 * cover the inline bootstrap scripts, so script-src keeps 'unsafe-inline' (the documented
 * "Without Nonces" setup). No unsafe-eval in production. Upgrade path: nonce + dynamic layout.
 */
export type HeaderEntry = { key: string; value: string };

function origin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export function buildCsp({ isDev, supabaseUrl }: { isDev: boolean; supabaseUrl?: string }): string {
  const supa = origin(supabaseUrl);
  const supaWs = supa ? supa.replace(/^http/, "ws") : null;
  const connect = ["'self'", supa, supaWs].filter(Boolean) as string[];
  // Dev needs ws://localhost for HMR and 'unsafe-eval' for React debugging.
  if (isDev) connect.push("ws://localhost:*", "ws://127.0.0.1:*");
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "blob:", "data:", ...(supa ? [supa] : [])],
    "font-src": ["'self'", "data:"],
    "connect-src": connect,
    // Voice notes later: recorded blobs play back via blob:. Uploaded media from Supabase Storage.
    "media-src": ["'self'", "blob:", ...(supa ? [supa] : [])],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    // Moyasar hosted payment page is reached by redirect after a form post (server action).
    "form-action": ["'self'", "https://moyasar.com", "https://*.moyasar.com"],
    "frame-ancestors": ["'none'"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!isDev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

export function securityHeaders({
  isDev,
  supabaseUrl,
  reportOnly = false,
}: {
  isDev: boolean;
  supabaseUrl?: string;
  reportOnly?: boolean;
}): HeaderEntry[] {
  const list: HeaderEntry[] = [
    {
      key: reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy",
      value: buildCsp({ isDev, supabaseUrl }),
    },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value:
        "microphone=(self), camera=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=(), interest-cohort=()",
    },
  ];
  if (!isDev) {
    list.push({ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" });
  }
  return list;
}
