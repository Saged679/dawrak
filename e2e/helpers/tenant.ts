import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

/**
 * Shared e2e helpers for the LOCAL Supabase stack. The service-role key is used only to inspect, seed
 * and clean up rows; the app under test never sees it.
 */
export function env(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const raw = readFileSync(".env.local", "utf8");
    return raw.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export const SUPABASE_URL = env("NEXT_PUBLIC_SUPABASE_URL");
export const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
export const ANON_KEY = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
export const hasLocalDb = () => !!SUPABASE_URL && !!SERVICE_KEY && !!ANON_KEY;

/** The fixed seeded demo users' password: local e2e only (supabase/seed.sql). The hosted demo has none. */
export const FIXED_DEMO_PASSWORD = env("DEMO_PASSWORD") ?? "Demo#2026";
export const FIXED_USERS = {
  "clinic-owner": "clinic-owner@example.com",
  "clinic-reception": "clinic-reception@example.com",
  "clinic-doctor": "clinic-doctor@example.com",
  "salon-owner": "salon-owner@example.com",
} as const;

export const CLINIC = "d0000000-0000-4000-8000-000000000001";
export const SALON = "d0000000-0000-4000-8000-000000000002";
export const DOCTOR = "f1000000-0000-4000-8000-000000000001"; // linked to clinic-doctor@
export const OTHER_DOCTOR = "f1000000-0000-4000-8000-000000000002";

export async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function clearRateLimits() {
  await rest("rate_limits?key=like.*", { method: "DELETE" });
}

export async function adminFetch(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...init.headers },
  });
}

/** Password grant against GoTrue with the anon key; returns the session tokens (never put in a page). */
export async function passwordGrant(email: string, password: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string };
  return { status: res.status, access: json.access_token, refresh: json.refresh_token };
}

/** One-click demo entry (a NEW temporary user per click). The action is rate limited per client. */
export async function enterDemo(page: Page, persona: string, locale = "en") {
  await clearRateLimits();
  await page.goto(`/${locale}/demo`);
  await page.getByTestId(`demo-${persona}`).click();
  await page.waitForURL(new RegExp(`/${locale}/dashboard`));
}

/** Signs in one of the six fixed seeded users through the normal login form (local e2e only). */
export async function loginFixed(page: Page, who: keyof typeof FIXED_USERS, locale = "en", next = "/dashboard") {
  await clearRateLimits();
  await loginWith(page, FIXED_USERS[who], FIXED_DEMO_PASSWORD, locale, next);
}

export async function loginWith(page: Page, email: string, password: string, locale = "en", next = "/dashboard") {
  await clearRateLimits();
  await page.goto(`/${locale}/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(new RegExp(`/${locale}${next.replace(/[/]/g, "\\/")}`));
}

/** The visitor's own (random) e-mail as shown in the user menu, to identify which user a context holds. */
export async function visitorEmail(page: Page): Promise<string> {
  const text = (await page.locator("body").textContent()) ?? "";
  const m = /v-[0-9a-f]{24}@demo\.dawrak\.invalid/.exec(text);
  expect(m, "visitor e-mail visible in the user menu").not.toBeNull();
  return m![0];
}

export async function userIdByEmail(email: string): Promise<string> {
  const res = await adminFetch(`/admin/users?per_page=1000`);
  const json = (await res.json()) as { users: { id: string; email: string }[] };
  const u = json.users.find((x) => x.email === email);
  if (!u) throw new Error("user not found");
  return u.id;
}

/**
 * Gives a throw-away visitor a known password through the Admin API and signs in server-side, so a test can
 * act with that user's OWN tokens (the cookie is httpOnly and never read by tests).
 */
export async function tokensForVisitor(email: string) {
  const id = await userIdByEmail(email);
  const password = `E2e-${Math.random().toString(36).slice(2)}-Pw1!`;
  const r = await adminFetch(`/admin/users/${id}`, { method: "PUT", body: JSON.stringify({ password }) });
  if (!r.ok) throw new Error(`set password: ${r.status}`);
  const t = await passwordGrant(email, password);
  if (!t.access) throw new Error("no tokens");
  return { id, email, password, access: t.access, refresh: t.refresh! };
}

export type TempTenant = {
  tenantId: string;
  slug: string;
  email: string;
  password: string;
  userId: string;
  cleanup: () => Promise<void>;
};

/**
 * A temporary NON-demo business with one owner login, created with the service role. Tests that edit the
 * catalogue, hours, time off or knowledge base run against it (the seeded demo business is read-only for
 * demo users). Call `cleanup()` in afterAll: it removes the tenant (cascades) and the auth user.
 */
export async function createTempTenant(opts: { kind?: "clinic" | "salon"; label?: string; role?: "owner" | "receptionist"; demo?: boolean } = {}): Promise<TempTenant> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `e2e-${opts.label ?? "owner"}-${stamp}@example.com`;
  const password = "E2e#Owner2026";
  const res = await adminFetch("/admin/users", { method: "POST", body: JSON.stringify({ email, password, email_confirm: true }) });
  if (!res.ok) throw new Error(`create user: ${res.status} ${await res.text()}`);
  const userId = ((await res.json()) as { id: string }).id;
  const slug = `e2e-${opts.label ?? "biz"}-${stamp}`;
  const [t] = (await rest("tenants", {
    method: "POST",
    body: JSON.stringify({ slug, name_ar: "عيادة اختبار", name_en: `E2E Business ${stamp}`, kind: opts.kind ?? "clinic", is_demo: opts.demo ?? false }),
  })) as { id: string }[];
  await rest("memberships", { method: "POST", body: JSON.stringify({ user_id: userId, tenant_id: t.id, role: opts.role ?? "owner" }) });
  return {
    tenantId: t.id,
    slug,
    email,
    password,
    userId,
    cleanup: async () => {
      await rest(`tenants?id=eq.${t.id}`, { method: "DELETE" }).catch(() => {});
      await adminFetch(`/admin/users/${userId}`, { method: "DELETE" }).catch(() => {});
    },
  };
}

/**
 * Inserts a row into a DEMO tenant as service_role and makes it a shared row (like the seed data) that every
 * demo visitor and the fixed staff users can see. A plain insert would be stamped with a random owner hash by the
 * database (fail-safe), which makes the row invisible to everybody. `ownerColumn` is `demo_session_hash` for
 * customers and appointments, `session_hash` for conversations. Pass `hash` to give the row to one visitor instead
 * (see demoSessionHash).
 */
export async function restShared<T extends { id: string }>(
  table: "customers" | "appointments" | "conversations",
  body: Record<string, unknown>,
  hash: string | null = null,
): Promise<T> {
  const col = table === "conversations" ? "session_hash" : "demo_session_hash";
  const [row] = (await rest(table, { method: "POST", body: JSON.stringify(body) })) as T[];
  await rest(`${table}?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ [col]: hash }) });
  return row;
}

/** The session hash that owns the demo data of the visitor currently signed in on `page`. */
export async function demoSessionHash(page: Page): Promise<string> {
  const id = await userIdByEmail(await visitorEmail(page));
  const [row] = (await rest(`demo_users?user_id=eq.${id}&select=session_hash`)) as { session_hash: string }[];
  expect(row?.session_hash, "demo visitor has a session hash").toMatch(/^[0-9a-f]{64}$/);
  return row.session_hash;
}

export type DepositTenant = TempTenant & { serviceId: string; providerId: string; serviceName: string; price: number };

/**
 * A temporary clinic with a 20% deposit, one service, one provider and all-day hours: payment flows run
 * here because the seeded demo clinic takes no deposit (frozen, so the demo never shows a payment screen). It is flagged
 * is_demo on purpose: the fake payment provider is only ever allowed for demo businesses (providerForTenant), and a
 * real business needs Moyasar keys. It has no seeded rows, so the per-visitor demo isolation plays no role here.
 */
export async function createDepositTenant(): Promise<DepositTenant> {
  const biz = await createTempTenant({ label: "deposit", demo: true });
  const price = 200;
  const serviceName = "Deposit Check-up";
  await rest(`tenants?id=eq.${biz.tenantId}`, { method: "PATCH", body: JSON.stringify({ deposit_enabled: true, deposit_type: "percent", deposit_value: 20, currency: "SAR" }) });
  const [svc] = (await rest("services", { method: "POST", body: JSON.stringify({ tenant_id: biz.tenantId, name_ar: "فحص", name_en: serviceName, duration_min: 30, price }) })) as { id: string }[];
  const [prov] = (await rest("providers", { method: "POST", body: JSON.stringify({ tenant_id: biz.tenantId, name_ar: "د. اختبار", name_en: "Dr. Deposit" }) })) as { id: string }[];
  await rest("provider_services", { method: "POST", body: JSON.stringify({ tenant_id: biz.tenantId, provider_id: prov.id, service_id: svc.id }) });
  await rest("working_hours", { method: "POST", body: JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((d) => ({ tenant_id: biz.tenantId, provider_id: prov.id, weekday: d, start_time: "00:00", end_time: "23:59" }))) });
  return { ...biz, serviceId: svc.id, providerId: prov.id, serviceName, price };
}
