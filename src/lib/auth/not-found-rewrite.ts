import { NextResponse } from "next/server";
import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";
import { localeDir, routing } from "@/i18n/routing";

const COPY = { ar: ar.Errors, en: en.Errors } as const;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The 404 for a path under `locale`, answered by the proxy itself as a small self-contained HTML document.
 * It deliberately does not go through a rewrite to a page: on Vercel a rewrite with status 404 is served from the
 * prerendered /404 output (the Arabic global-not-found), so lang/dir/copy were always Arabic. Here lang, dir and
 * copy come straight from the locale segment of the path; no header, cookie or Accept-Language is consulted.
 */
export function notFoundResponse(locale: string, carry?: NextResponse): NextResponse {
  const l = (routing.locales as readonly string[]).includes(locale) ? (locale as keyof typeof COPY) : routing.defaultLocale;
  const t = COPY[l];
  const html = `<!DOCTYPE html><html lang="${l}" dir="${localeDir[l]}"><head><meta charSet="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex"/>
<title>${esc(t.notFoundTitle)}</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:#eef2f9;color:#101c3a;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}
main{margin:0 auto;width:100%;max-width:42rem;flex:1;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:1rem;padding:4rem 1.5rem;box-sizing:border-box}
p.c{margin:0;font-size:.875rem;font-weight:600;color:#1b37a3}.r{width:3rem;height:.25rem;border-radius:9999px;background:#f2a93b}
h1{margin:0;font-size:1.875rem;font-weight:600}p.b{margin:0;font-size:1.125rem;color:#4a5675;max-width:40em}
a{display:inline-flex;min-height:2.75rem;align-items:center;border-radius:.5rem;background:#2549d1;color:#fff;padding:.5rem 1.25rem;font-weight:500;text-decoration:none;margin-top:.5rem}a:focus-visible{outline:2px solid #2549d1;outline-offset:2px}</style></head>
<body><main><p class="c" dir="ltr">404</p><span class="r" aria-hidden="true"></span><h1>${esc(t.notFoundTitle)}</h1><p class="b">${esc(t.notFoundBody)}</p><a href="/${l}">${esc(t.home)}</a></main></body></html>`;
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-language": l,
    "cache-control": "public, max-age=0, must-revalidate",
    "x-robots-tag": "noindex",
    vary: "accept-language, cookie",
  });
  const res = new NextResponse(html, { status: 404, headers });
  // Keep a locale cookie that next-intl's middleware decided to set (NEXT_LOCALE), as the rewrite used to.
  const setCookie = carry?.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) res.headers.append("set-cookie", c);
  return res;
}
