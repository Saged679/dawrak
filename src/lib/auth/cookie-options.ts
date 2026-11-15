/**
 * Options for the Supabase auth cookies (server client + proxy). Names are the ones @supabase/ssr
 * 0.12 reads from `createServerClient(..., { cookieOptions })`; they are merged into every cookie it
 * writes, including the ones that clear the session.
 *
 * httpOnly: nothing in the app reads the session in the browser (there is no createBrowserClient and
 * no document.cookie access), so page scripts never need the tokens and an XSS cannot steal them.
 */
export const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
/** Demo visitors are deleted after 6 h (demo_users.expires_at), so their session cookie need not live longer. */
export const DEMO_VISITOR_TTL_HOURS = 6;
export const DEMO_AUTH_COOKIE_MAX_AGE = 60 * 60 * DEMO_VISITOR_TTL_HOURS;

export function authCookieOptions(opts: { maxAge?: number; production?: boolean } = {}) {
  return {
    httpOnly: true as const,
    secure: opts.production ?? process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: opts.maxAge ?? AUTH_COOKIE_MAX_AGE,
  };
}

/**
 * @supabase/ssr 0.12 forces `maxAge` to its own 400 days on every cookie it writes (cookies.js), whatever
 * `cookieOptions.maxAge` says, so the lifetime is applied here, in the `setAll` callbacks. Removal cookies
 * (maxAge 0) are left alone.
 */
export function withAuthMaxAge<T extends { maxAge?: number }>(options: T, maxAge: number = AUTH_COOKIE_MAX_AGE): T {
  return options.maxAge === 0 ? options : { ...options, maxAge };
}
