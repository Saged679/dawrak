"use server";

import { cookies, headers } from "next/headers";
import { hasLocale } from "next-intl";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { getClientIp } from "@/lib/db/client-ip";
import { rateLimitOk } from "@/lib/db/public";
import { getServiceClient } from "@/lib/db/client";
import { createDemoVisitor, isVisitorForPersona } from "@/lib/demo/visitor";
import { demoEnabled, isDemoPersona } from "./demo";
import { DEMO_AUTH_COOKIE_MAX_AGE } from "./cookie-options";
import { safeNextPath } from "./roles";
import { getSession, TENANT_COOKIE } from "./session";
import { createSupabaseServerClient } from "./supabase";

export type LoginState = {
  error: "invalid" | "credentials" | "rate_limited" | "generic" | null;
};

const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

function localeOf(fd: FormData): string {
  const v = fd.get("locale");
  return typeof v === "string" && hasLocale(routing.locales, v) ? v : routing.defaultLocale;
}

async function clientKey(): Promise<string> {
  return getClientIp(await headers());
}

export async function signIn(_prev: LoginState, fd: FormData): Promise<LoginState> {
  const locale = localeOf(fd);
  const parsed = loginSchema.safeParse({ email: fd.get("email"), password: fd.get("password") });
  if (!parsed.success) return { error: "invalid" };

  try {
    if (!(await rateLimitOk(`ip:${await clientKey()}:login`, 15, "10 minutes"))) {
      return { error: "rate_limited" };
    }
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword(parsed.data);
    if (error) {
      // Same message for unknown user and wrong password.
      return { error: error.status && error.status >= 500 ? "generic" : "credentials" };
    }
  } catch (e) {
    console.error("login_error", e instanceof Error ? e.message : e);
    return { error: "generic" };
  }
  const next = fd.get("next");
  redirect({ href: safeNextPath(typeof next === "string" ? next : null), locale });
  return { error: null };
}

export async function signOut(fd: FormData): Promise<void> {
  const locale = localeOf(fd);
  const supabase = await createSupabaseServerClient();
  // "local": end only this browser session. The default ("global") revokes every session of the
  // user, which on the shared demo accounts would sign every other visitor out too.
  await supabase.auth.signOut({ scope: "local" });
  (await cookies()).delete(TENANT_COOKIE);
  redirect({ href: "/login", locale });
}

/** Switches the active tenant. The id must match one of the caller's own memberships. */
export async function switchTenant(fd: FormData): Promise<void> {
  const locale = localeOf(fd);
  const session = await getSession();
  const id = fd.get("tenantId");
  if (session && typeof id === "string" && session.memberships.some((m) => m.tenant.id === id)) {
    (await cookies()).set(TENANT_COOKIE, id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  redirect({ href: "/dashboard", locale });
}

/**
 * One-click demo sign-in, one temporary user per visitor (no shared login). A visitor who already holds a
 * registered, unexpired session for the requested persona is simply sent on; anyone else gets a NEW
 * auth user created through the Admin API with a random e-mail and a random password that exists only
 * inside this call. Any failure deletes the half-made user again.
 */
export async function enterDemo(fd: FormData): Promise<void> {
  const locale = localeOf(fd);
  if (!demoEnabled()) redirect({ href: "/", locale });
  const persona = fd.get("persona");
  if (!isDemoPersona(persona)) {
    redirect({ href: { pathname: "/demo", query: { error: "invalid" } }, locale });
    return;
  }

  let failure: "rate" | "signin" | "busy" | null = null;
  try {
    if (!(await rateLimitOk(`ip:${await clientKey()}:demo`, 30, "10 minutes"))) {
      failure = "rate";
    } else {
      const admin = getServiceClient();
      const supabase = await createSupabaseServerClient({ maxAge: DEMO_AUTH_COOKIE_MAX_AGE });
      const { data: current } = await supabase.auth.getUser();
      if (current.user && (await isVisitorForPersona(admin, current.user.id, persona))) {
        // already this persona: keep the session, nothing to create
      } else {
        // End only this browser's previous session ("local"); never a global logout.
        if (current.user) await supabase.auth.signOut({ scope: "local" });
        const res = await createDemoVisitor(persona, {
          admin,
          signInWithPassword: async (email, password) => {
            const { error } = await supabase.auth.signInWithPassword({ email, password });
            return { error: error ? { status: error.status, message: error.message } : null };
          },
          signOutLocal: async () => {
            await supabase.auth.signOut({ scope: "local" });
          },
        });
        if (!res.ok) failure = res.failure;
      }
      // A previous session may have chosen another tenant.
      if (!failure) (await cookies()).delete(TENANT_COOKIE);
    }
  } catch (e) {
    console.error("demo_error", e instanceof Error ? e.message : e);
    failure = "signin";
  }
  if (failure) redirect({ href: { pathname: "/demo", query: { error: failure } }, locale });
  redirect({ href: "/dashboard", locale });
}
