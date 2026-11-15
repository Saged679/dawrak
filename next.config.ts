import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { securityHeaders } from "./src/lib/security/headers";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const privatePageHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "private, no-store" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  // `next dev` otherwise (re)writes AGENTS.md into the repo root whenever it detects a coding
  // agent. Documented option, see node_modules/next/dist/docs/.../next-config-js/agentRules.md.
  agentRules: false,
  // Lets a second production build (e.g. an isolated e2e run) live beside a running server's .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  // Lets src/app/global-not-found.tsx answer paths outside the locale tree (own html, lang=ar dir=rtl).
  experimental: { globalNotFound: true },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders({
          isDev: process.env.NODE_ENV !== "production",
          supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        }),
      },
      // Pages whose URL (or content) holds a personal secret: never send a Referer, never cache, never index.
      // A later rule overrides the same header key set by the global rule above.
      {
        source: "/:locale/c/:slug/my/:path*",
        headers: privatePageHeaders,
      },
      { source: "/:locale/demo/mailbox", headers: privatePageHeaders },
      // Payment pages: the URL carries the payment token (L6).
      { source: "/:locale/c/:slug/pay/:path*", headers: privatePageHeaders },
    ];
  },
};

export default withNextIntl(nextConfig);
