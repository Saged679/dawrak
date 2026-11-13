import "server-only";
import { rateLimitOk } from "@/lib/db/public";
import type { SessionContext } from "@/lib/auth/session";
import type { KbErrorCode } from "./knowledge";

/** Knowledge-base writes embed text with the Gemini free tier, so they are capped per user and per tenant. */
export const KB_WRITE_LIMITS = {
  user: { max: 10, window: "10 minutes" },
  tenantDay: { max: 50, window: "1 day" },
  demoTenantDay: { max: 20, window: "1 day" },
} as const;

type Limiter = (key: string, max: number, window: string) => Promise<boolean>;

/**
 * Counts one knowledge-base write (FAQ, text, reindex, PDF) against the per-user and per-tenant
 * limits (public.check_rate_limit). Returns null when allowed, else the KbErrorCode to show.
 * Fails closed: if the limiter itself errors the write is refused ("generic").
 */
export async function checkKbWriteLimit(
  session: Pick<SessionContext, "userId" | "tenant">,
  limiter: Limiter = rateLimitOk,
): Promise<KbErrorCode | null> {
  try {
    const u = KB_WRITE_LIMITS.user;
    if (!(await limiter(`user:${session.userId}:kb:write`, u.max, u.window))) return "write_limit";
    const t = session.tenant.is_demo ? KB_WRITE_LIMITS.demoTenantDay : KB_WRITE_LIMITS.tenantDay;
    if (!(await limiter(`tenant:${session.tenant.id}:kb:write:day`, t.max, t.window))) return "write_limit";
    return null;
  } catch (e) {
    console.error("kb_rate_limit_error", e instanceof Error ? e.message : "unknown");
    return "generic";
  }
}
