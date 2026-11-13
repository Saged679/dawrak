import type { AgentDb } from "./types";

export const CHAT_LIMITS = {
  /** per IP: 20 messages / 10 minutes */
  ip: { max: 20, window: "10 minutes", windowSeconds: 600 },
  /** per tenant: 300 messages / day (keeps the Gemini free tier safe) */
  tenantDay: { max: 300, window: "1 day", windowSeconds: 86400 },
  /**
   * Voice notes cost more Gemini free-tier quota (32 audio tokens/s plus a longer answer), so they
   * get their own, stricter buckets on top of the general ones above.
   */
  audioIp: { max: 6, window: "10 minutes", windowSeconds: 600 },
  audioTenantDay: { max: 60, window: "1 day", windowSeconds: 86400 },
} as const;

export type LimitResult = { ok: true } | { ok: false; scope: "ip" | "tenant"; retryAfterSeconds: number };

/** Uses public.check_rate_limit (service role). Throws if the DB call fails (caller fails closed). */
async function hit(db: AgentDb, key: string, max: number, window: string): Promise<boolean> {
  const { data, error } = await db.rpc("check_rate_limit", { p_key: key, p_max: max, p_window: window });
  if (error) throw error;
  return data === true;
}

export async function checkIpLimit(db: AgentDb, ip: string): Promise<LimitResult> {
  const l = CHAT_LIMITS.ip;
  return (await hit(db, `ip:${ip}:chat`, l.max, l.window))
    ? { ok: true }
    : { ok: false, scope: "ip", retryAfterSeconds: l.windowSeconds };
}

export async function checkTenantLimit(db: AgentDb, tenantId: string): Promise<LimitResult> {
  const l = CHAT_LIMITS.tenantDay;
  return (await hit(db, `tenant:${tenantId}:chat:day`, l.max, l.window))
    ? { ok: true }
    : { ok: false, scope: "tenant", retryAfterSeconds: l.windowSeconds };
}

export async function checkAudioIpLimit(db: AgentDb, ip: string): Promise<LimitResult> {
  const l = CHAT_LIMITS.audioIp;
  return (await hit(db, `ip:${ip}:chat:audio`, l.max, l.window))
    ? { ok: true }
    : { ok: false, scope: "ip", retryAfterSeconds: l.windowSeconds };
}

export async function checkAudioTenantLimit(db: AgentDb, tenantId: string): Promise<LimitResult> {
  const l = CHAT_LIMITS.audioTenantDay;
  return (await hit(db, `tenant:${tenantId}:chat:audio:day`, l.max, l.window))
    ? { ok: true }
    : { ok: false, scope: "tenant", retryAfterSeconds: l.windowSeconds };
}
