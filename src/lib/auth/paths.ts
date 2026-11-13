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
