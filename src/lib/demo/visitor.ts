import "server-only";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_VISITOR_DOMAIN, PERSONA_TARGET, type DemoPersona } from "@/lib/auth/demo";

export type DemoFailure = "busy" | "signin";

export type DemoVisitorDeps = {
  /** service-role client (Admin API + RPC) */
  admin: SupabaseClient;
  /** signs the new user in on the server so the SSR client sets the cookies */
  signInWithPassword: (email: string, password: string) => Promise<{ error: { status?: number; message: string } | null }>;
  /** removes the cookies of a half-made session (scope local) */
  signOutLocal: () => Promise<void>;
};

const NEVER_DELETE = /^a0000000-0000-4000-8000-00000000000[0-9]$/;

/** Random e-mail on a non-routable domain; random 32-byte password. Never logged, never stored. */
export function newVisitorCredentials(): { email: string; password: string } {
  return {
    email: `v-${randomBytes(12).toString("hex")}@${DEMO_VISITOR_DOMAIN}`,
    password: randomBytes(32).toString("base64url"),
  };
}

async function deleteQuietly(admin: SupabaseClient, id: string): Promise<void> {
  try {
    await admin.auth.admin.deleteUser(id);
  } catch (e) {
    console.error("demo_cleanup_error", e instanceof Error ? e.message : "unknown");
  }
}

/**
 * Creates one temporary visitor, signs it in and registers it. On ANY failure the created auth user is
 * deleted again (and the half-made session cookies cleared) and a coarse failure code is returned.
 */
export async function createDemoVisitor(persona: DemoPersona, deps: DemoVisitorDeps): Promise<{ ok: true; userId: string } | { ok: false; failure: DemoFailure }> {
  const target = PERSONA_TARGET[persona];
  const { email, password } = newVisitorCredentials();
  let userId: string | null = null;
  try {
    const { data, error } = await deps.admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { demo_visitor: true },
      user_metadata: { full_name: "Demo visitor" },
    });
    if (error || !data?.user) {
      console.error("demo_create_user_failed", error?.status, error?.message);
      return { ok: false, failure: "signin" };
    }
    userId = data.user.id;
    if (NEVER_DELETE.test(userId)) return { ok: false, failure: "signin" };

    const signed = await deps.signInWithPassword(email, password);
    if (signed.error) {
      console.error("demo_signin_failed", signed.error.status, signed.error.message);
      throw new Error("signin");
    }
    const { error: regError } = await deps.admin.rpc("register_demo_user", {
      p_user_id: userId,
      p_tenant_id: target.tenantId,
      p_role: target.role,
    });
    if (regError) {
      const busy = regError.code === "54000" || /demo_users_limit|demo_tenant_users_limit/.test(regError.message ?? "");
      console.error("demo_register_failed", regError.code, regError.message);
      const e = new Error(busy ? "busy" : "register");
      throw e;
    }
    return { ok: true, userId };
  } catch (e) {
    const busy = e instanceof Error && e.message === "busy";
    if (userId) await deleteQuietly(deps.admin, userId);
    try {
      await deps.signOutLocal();
    } catch {
      /* the session died with the user anyway */
    }
    return { ok: false, failure: busy ? "busy" : "signin" };
  }
}

/** True when `userId` is a registered, unexpired demo visitor of exactly this persona's tenant and role. */
export async function isVisitorForPersona(admin: SupabaseClient, userId: string, persona: DemoPersona): Promise<boolean> {
  const target = PERSONA_TARGET[persona];
  const { data, error } = await admin
    .from("demo_users")
    .select("tenant_id, role, expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return false;
  const r = data as { tenant_id: string; role: string; expires_at: string };
  return r.tenant_id === target.tenantId && r.role === target.role && new Date(r.expires_at).getTime() > Date.now();
}
