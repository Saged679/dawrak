import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authCookieOptions, withAuthMaxAge } from "./cookie-options";

/**
 * Supabase client bound to the signed-in user's cookies (authenticated role, RLS applies).
 * Server components, server actions and route handlers only. In a server component the cookie
 * write is not allowed; the proxy already refreshed the session, so that error is ignored.
 */
export async function createSupabaseServerClient(opts: { maxAge?: number } = {}) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  const store = await cookies();
  return createServerClient(url, key, {
    cookieOptions: authCookieOptions({ maxAge: opts.maxAge }),
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, withAuthMaxAge(options, opts.maxAge));
        } catch {
          // called from a server component: the proxy owns the refresh
        }
      },
    },
  });
}
