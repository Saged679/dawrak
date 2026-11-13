import "server-only";

/**
 * Hosted demo sign-in is per visitor: each click creates a temporary auth user (random e-mail, random
 * password, both generated on the server and never shown) and registers it as a demo visitor of one
 * of the two demo businesses. There is no shared demo login and no demo password in the app.
 *
 * Only three personas exist. The "provider" role cannot be per-visitor (a provider membership is tied
 * to one seeded providers row), so it is exercised by e2e specs with the fixed seeded users instead.
 */
export const DEMO_PERSONAS = ["clinic-owner", "clinic-reception", "salon-owner"] as const;
export type DemoPersona = (typeof DEMO_PERSONAS)[number];

export function isDemoPersona(v: unknown): v is DemoPersona {
  return typeof v === "string" && (DEMO_PERSONAS as readonly string[]).includes(v);
}

export const DEMO_CLINIC_ID = "d0000000-0000-4000-8000-000000000001";
export const DEMO_SALON_ID = "d0000000-0000-4000-8000-000000000002";

export const PERSONA_TARGET: Record<DemoPersona, { tenantId: string; role: "owner" | "receptionist" }> = {
  "clinic-owner": { tenantId: DEMO_CLINIC_ID, role: "owner" },
  "clinic-reception": { tenantId: DEMO_CLINIC_ID, role: "receptionist" },
  "salon-owner": { tenantId: DEMO_SALON_ID, role: "owner" },
};

type DemoEnv = { DEMO_MODE?: string } & Record<string, string | undefined>;

/** Demo is on only when DEMO_MODE is exactly "true" (same rule as the payments module). */
export function demoEnabled(env: DemoEnv = process.env as DemoEnv): boolean {
  return env.DEMO_MODE === "true";
}

/** Non-routable domain (RFC 2606 `.invalid`): no mail can ever be delivered to a visitor account. */
export const DEMO_VISITOR_DOMAIN = "demo.dawrak.invalid";
