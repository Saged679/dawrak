import { routing } from "@/i18n/routing";

export type PathInfo = {
  locale: string | null;
  /** Path without the locale prefix, always starting with "/". */
  path: string;
  /** Runs Supabase session refresh. */
  needsSession: boolean;
  /** Requires a signed-in user. */
  protectedRoute: boolean;
};

/** Splits "/ar/dashboard/calendar" into locale + "/dashboard/calendar" and classifies it. */
export function pathInfo(pathname: string): PathInfo {
  const seg = pathname.split("/");
  const first = seg[1] ?? "";
  const locale = (routing.locales as readonly string[]).includes(first) ? first : null;
  const path = locale ? `/${seg.slice(2).join("/")}` : pathname;
  const protectedRoute = path === "/dashboard" || path.startsWith("/dashboard/");
  const needsSession = protectedRoute || path === "/login" || path === "/demo";
  return { locale, path: path === "" ? "/" : path, needsSession, protectedRoute };
}

/**
 * Routes that exist under /[locale]: the first path segment, and how deep each may go. "any" segments own
 * their sub-paths (their pages call notFound() themselves for unknown ids). Keep in sync with src/app/[locale]
 * (tests/dashboard/auth-helpers.test.ts compares this list with the directory).
 */
export const LOCALE_ROUTES: Record<string, "leaf" | "any" | string[]> = {
  login: "leaf",
  boom: "leaf",
  "opengraph-image": "leaf",
  demo: ["mailbox"],
  c: "any",
  dashboard: "any",
};

/**
 * False for a path (without locale) that no route can match. The proxy answers those with a real server
 * rendered 404 page: a notFound() thrown by a page gets Next's client-rendered error shell (empty HTML, no
 * lang or dir) which a visitor without JavaScript sees as a blank page.
 */
export function isKnownLocalePath(path: string): boolean {
  const seg = path.split("/").filter(Boolean);
  if (seg.length === 0) return true;
  // own keys only: "__proto__", "constructor", "toString" ... must not resolve through the prototype chain
  if (!Object.hasOwn(LOCALE_ROUTES, seg[0])) return false;
  const rule = LOCALE_ROUTES[seg[0]];
  if (rule === "any") return true;
  if (rule === "leaf") return seg.length === 1;
  return seg.length === 1 || (seg.length === 2 && Array.isArray(rule) && rule.includes(seg[1]));
}
