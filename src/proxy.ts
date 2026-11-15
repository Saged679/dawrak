import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { authCookieOptions, DEMO_AUTH_COOKIE_MAX_AGE, withAuthMaxAge } from "./lib/auth/cookie-options";
import { notFoundRewrite } from "./lib/auth/not-found-rewrite";
import { isKnownLocalePath, pathInfo } from "./lib/auth/paths";
import { tenantSlugExists } from "./lib/db/tenant-exists";

const handleIntl = createMiddleware(routing);

export default async function proxy(request: NextRequest) {
  // 1. next-intl: locale detection / redirects / rewrite headers.
  const response = handleIntl(request);

  // 2. Supabase session refresh + route protection, only where a session matters.
  const { locale, path, needsSession, protectedRoute } = pathInfo(request.nextUrl.pathname);

  // 1b. A path under a locale that no route matches: answer with the server-rendered 404 page (see isKnownLocalePath).
  if (locale && !isKnownLocalePath(path) && !response.headers.get("location")) {
    return notFoundRewrite(request, locale, response);
  }
  // 1c. Same for /c/<unknown-slug>[/...]: a notFound() thrown by the page would give the empty error shell.
  if (locale && !response.headers.get("location")) {
    const m = /^\/c\/([^/]+)/.exec(path);
    if (m && !(await tenantSlugExists(m[1]))) return notFoundRewrite(request, locale, response);
  }
  if (!locale || !needsSession) return response;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  // Cookies written by the token refresh below; re-issued with the short demo lifetime for demo visitors.
  const refreshed: { name: string; value: string; options: { maxAge?: number } }[] = [];
  const supabase = createServerClient(url, key, {
    cookieOptions: authCookieOptions(),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        // Refreshed tokens must reach both the rest of this request and the browser.
        for (const { name, value } of list) request.cookies.set(name, value);
        for (const { name, value, options } of list) {
          response.cookies.set(name, value, withAuthMaxAge(options));
          refreshed.push({ name, value, options });
        }
      },
    },
  });

  // getUser() verifies the token with the auth server (getSession() would trust the cookie).
  const { data } = await supabase.auth.getUser();
  // M1: a refresh must not stretch a demo visitor's cookie back to the 7-day default (the account is gone after 6 h).
  if (data.user?.app_metadata?.demo_visitor === true) {
    for (const { name, value, options } of refreshed) {
      response.cookies.set(name, value, withAuthMaxAge(options, DEMO_AUTH_COOKIE_MAX_AGE));
    }
  }

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
