import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "@/i18n/navigation";
import { createSupabaseServerClient } from "./supabase";
import { isRole, type Role } from "./roles";
import { pickMembership, type MembershipInfo, type TenantInfo } from "./membership";

export { pickMembership, type MembershipInfo, type TenantInfo };

export const TENANT_COOKIE = "dawrak_tenant";

export type SessionContext = {
  userId: string;
  email: string;
  fullName: string | null;
  tenant: TenantInfo;
  role: Role;
  /** The providers row linked to this login (provider role only). */
  providerId: string | null;
  memberships: MembershipInfo[];
};

type MembershipRow = {
  role: string;
  tenants: TenantInfo | TenantInfo[] | null;
};

/**
 * The current user, their active tenant and role, all derived from the verified session and the
 * `memberships` table (RLS). Nothing tenant-related is ever taken from the request.
 * Returns null when signed out, or when the user has no membership.
 */
export const getSession = cache(async (): Promise<SessionContext | null> => {
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;
  if (!user) return null;

  const { data, error } = await supabase
    .from("memberships")
    .select("role, tenants(id, name_ar, name_en, kind, timezone, currency, is_demo)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const memberships: MembershipInfo[] = [];
  for (const row of (data ?? []) as unknown as MembershipRow[]) {
    const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
    if (tenant && isRole(row.role)) memberships.push({ tenant, role: row.role });
  }

  const store = await cookies();
  const active = pickMembership(memberships, store.get(TENANT_COOKIE)?.value);
  if (!active) return null;

  let providerId: string | null = null;
  if (active.role === "provider") {
    const { data: p } = await supabase
      .from("providers")
      .select("id")
      .eq("tenant_id", active.tenant.id)
      .eq("user_id", user.id)
      .maybeSingle();
    providerId = (p as { id: string } | null)?.id ?? null;
  }

  const meta = user.user_metadata as { full_name?: unknown } | null;
  return {
    userId: user.id,
    email: user.email ?? "",
    fullName: typeof meta?.full_name === "string" ? meta.full_name : null,
    tenant: active.tenant,
    role: active.role,
    providerId,
    memberships,
  };
});

/** For pages: redirects to the login page when signed out. */
export async function requireSession(locale: string): Promise<SessionContext> {
  const session = await getSession();
  if (!session) redirect({ href: "/login", locale });
  return session!;
}

/** For pages: also enforces the role on the server (hiding a link is never the control). */
export async function requireRole(
  locale: string,
  allowed: readonly Role[],
): Promise<SessionContext> {
  const session = await requireSession(locale);
  if (!allowed.includes(session.role)) redirect({ href: "/dashboard", locale });
  return session;
}
