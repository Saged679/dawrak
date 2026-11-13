import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { authCookieOptions, withAuthMaxAge } from "./lib/auth/cookie-options";
import { pathInfo } from "./lib/auth/paths";

const handleIntl = createMiddleware(routing);

export default async function proxy(request: NextRequest) {
  // 1. next-intl: locale detection / redirects / rewrite headers.
  const response = handleIntl(request);

  // 2. Supabase session refresh + route protection, only where a session matters.
  const { locale, path, needsSession, protectedRoute } = pathInfo(request.nextUrl.pathname);
  if (!locale || !needsSession) return response;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookieOptions: authCookieOptions(),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        // Refreshed tokens must reach both the rest of this request and the browser.
        for (const { name, value } of list) request.cookies.set(name, value);
        for (const { name, value, options } of list) response.cookies.set(name, value, withAuthMaxAge(options));
      },
    },
  });

  // getUser() verifies the token with the auth server (getSession() would trust the cookie).
  const { data } = await supabase.auth.getUser();

  if (protectedRoute) {
    response.headers.set("Cache-Control", "private, no-store");
    if (!data.user) {
      const login = request.nextUrl.clone();
      login.pathname = `/${locale}/login`;
      login.search = "";
      login.searchParams.set("next", path + request.nextUrl.search);
      const redirect = NextResponse.redirect(login);
      for (const c of response.cookies.getAll()) redirect.cookies.set(c);
      redirect.headers.set("Cache-Control", "private, no-store");
      return redirect;
    }
  }
  return response;
}

export const config = {
  // Skip API routes, Next internals and files with an extension.
  matcher: ["/((?!api|trpc|_next|_vercel|.*\\..*).*)"],
};
