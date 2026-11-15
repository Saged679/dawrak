import { NextResponse, type NextRequest } from "next/server";

/**
 * The server-rendered 404 for a path in `locale`. The rewrite carries the locale itself (next-intl's request header
 * and a response header), so the page renders in the language of the path, never in the default one.
 */
export function notFoundRewrite(request: NextRequest, locale: string, carry: NextResponse): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = `/${locale}/page-not-found`;
  const headers = new Headers(request.headers);
  headers.set("x-next-intl-locale", locale);
  const res = NextResponse.rewrite(url, { status: 404, request: { headers } });
  res.headers.set("x-next-intl-locale", locale);
  for (const c of carry.cookies.getAll()) res.cookies.set(c);
  return res;
}
