import { createGoogleGenerativeAI, google, type GoogleProvider } from "@ai-sdk/google";

/**
 * Gemini API key pool (free tier: quotas are per project, so several keys from several projects multiply them).
 *
 *   GOOGLE_GENERATIVE_AI_API_KEYS   comma-separated list (trimmed, de-duplicated, empty entries ignored)
 *   GOOGLE_GENERATIVE_AI_API_KEY    single key (legacy); used as the sole key, or appended to the list when the
 *                                   list does not already contain it
 *
 * Rules:
 *  - The start index rotates round-robin per call, so load is spread over the keys.
 *  - A key that fails with quota / overload / invalid-key errors gets a per-bucket cooldown in memory and is skipped
 *    until it expires. Buckets are "<model>" for quota and overload (Gemini quotas are per model) and a global bucket
 *    for invalid keys.
 *  - Keys NEVER leave this module: errors are scrubbed, logs carry only the index ("#2"). The key travels in the
 *    x-goog-api-key header (never in the URL), so provider errors do not contain it either.
 *  - Failover wraps ONE model call (doStream / doGenerate / embed), which is made before the AI SDK executes any
 *    tool. A retry therefore can never run a tool twice; and once a stream has started it is never retried.
 */

export function keysFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    for (const part of (raw ?? "").split(",")) {
      const k = part.trim();
      if (k && !out.includes(k)) out.push(k);
    }
  };
  add(env.GOOGLE_GENERATIVE_AI_API_KEYS);
  add(env.GOOGLE_GENERATIVE_AI_API_KEY);
  return out;
}

export function hasGeminiKey(env: Record<string, string | undefined> = process.env): boolean {
  return keysFromEnv(env).length > 0;
}

// ---------------------------------------------------------------------------------------------
// Error classification (key level)
// ---------------------------------------------------------------------------------------------

export type KeyFailure =
  { kind: "quota"; scope: "day" | "minute"; retryAfterSeconds?: number } | { kind: "overloaded" } | { kind: "invalid" };

type Shaped = {
  status?: number;
  bodyStatus?: string;
  text: string;
  retryDelay?: string;
};

function shape(err: unknown): Shaped {
  const e = err as {
    statusCode?: number;
    status?: number;
    responseBody?: string;
    data?: unknown;
    message?: string;
  } | null;
  let body:
    | {
        error?: {
          code?: number;
          status?: string;
          message?: string;
          details?: {
            retryDelay?: string;
            violations?: { quotaId?: string; quotaMetric?: string }[];
          }[];
        };
      }
    | undefined;
  if (e?.data && typeof e.data === "object") body = e.data as typeof body;
  if (!body && typeof e?.responseBody === "string") {
    try {
      body = JSON.parse(e.responseBody) as typeof body;
    } catch {
      /* not JSON */
    }
  }
  const quotaIds = (body?.error?.details ?? [])
    .flatMap((d) => (d.violations ?? []).map((v) => `${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`))
    .join(" ");
  return {
    status: e?.statusCode ?? e?.status ?? body?.error?.code,
    bodyStatus: body?.error?.status,
    text: `${e?.message ?? ""} ${body?.error?.message ?? ""} ${quotaIds}`,
    retryDelay: (body?.error?.details ?? []).find((d) => d.retryDelay)?.retryDelay,
  };
}

function seconds(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Math.ceil(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}

/** What a failure means for the KEY (so the next key may succeed). Null: not a key problem, rethrow as is. */
export function classifyKeyError(err: unknown, depth = 0): KeyFailure | null {
  if (!err || depth > 4) return null;
  const s = shape(err);
  const invalid =
    s.status === 401 ||
    s.status === 403 ||
    /API_KEY_INVALID|API key not valid|API key expired|PERMISSION_DENIED|UNAUTHENTICATED|API_KEY_SERVICE_BLOCKED/i.test(
      s.bodyStatus + " " + s.text,
    ) ||
    (s.status === 400 && /API key/i.test(s.text));
  if (invalid) return { kind: "invalid" };
  if (s.status === 429 || s.bodyStatus === "RESOURCE_EXHAUSTED" || /RESOURCE_EXHAUSTED|quota exceeded/i.test(s.text)) {
    let retryAfterSeconds = seconds(s.retryDelay);
    if (retryAfterSeconds === undefined) {
      const hint = /retry in ([0-9hms.]+?)[.\s]*(?:$|[^0-9hms.])/i.exec(s.text);
      retryAfterSeconds = seconds(hint?.[1]);
    }
    let scope: "day" | "minute";
    if (/PerDay|per\s*day|daily/i.test(s.text)) scope = "day";
    else if (/PerMinute|per\s*minute/i.test(s.text)) scope = "minute";
    else if (retryAfterSeconds !== undefined) scope = retryAfterSeconds > 120 ? "day" : "minute";
    else scope = /free_tier_requests/i.test(s.text) ? "day" : "minute";
    return { kind: "quota", scope, retryAfterSeconds };
  }
  if (s.status === 503 || s.bodyStatus === "UNAVAILABLE" || /overloaded/i.test(s.text)) return { kind: "overloaded" };
  const inner = (err as { lastError?: unknown; cause?: unknown }).lastError ?? (err as { cause?: unknown }).cause;
  return inner ? classifyKeyError(inner, depth + 1) : null;
}

// ---------------------------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------------------------

export const COOLDOWN_MINUTE_MS = 60_000;
export const COOLDOWN_MINUTE_MAX_MS = 5 * 60_000;
export const COOLDOWN_DAY_MAX_MS = 60 * 60_000;
export const COOLDOWN_OVERLOAD_MS = 20_000;
export const COOLDOWN_INVALID_MS = 6 * 60 * 60_000;
const GLOBAL = "*";

type Cooldown = { until: number; error: unknown };

export class KeyPool {
  private readonly keys: string[];
  private cursor = 0;
  private cooldowns = new Map<string, Cooldown>();
  private providers = new Map<number, GoogleProvider>();

  constructor(
    keys: string[],
    private now: () => number = Date.now,
    private log: (msg: string) => void = (m) => console.warn(m),
  ) {
    this.keys = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
  }

  get size(): number {
    return this.keys.length;
  }

  /** Google provider of key #index (cached). */
  provider(index: number): GoogleProvider {
    let p = this.providers.get(index);
    if (!p) {
      p = createGoogleGenerativeAI({ apiKey: this.keys[index] });
      this.providers.set(index, p);
    }
    return p;
  }

  private cooling(index: number, bucket: string): Cooldown | null {
    for (const id of [`${index}:${GLOBAL}`, `${index}:${bucket}`]) {
      const c = this.cooldowns.get(id);
      if (!c) continue;
      if (c.until <= this.now()) this.cooldowns.delete(id);
      else return c;
    }
    return null;
  }

  /** Key indexes to try for `bucket`, in round-robin order starting after the previous start. Skips cooling keys. */
  order(bucket: string): number[] {
    const n = this.keys.length;
    const start = n ? this.cursor++ % n : 0;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      if (!this.cooling(idx, bucket)) out.push(idx);
    }
    return out;
  }

  /** The error that put the soonest-recovering key of `bucket` in cooldown (used when every key is cooling). */
  lastCooldownError(bucket: string): unknown {
    let best: Cooldown | null = null;
    for (let i = 0; i < this.keys.length; i++) {
      const c = this.cooling(i, bucket);
      if (c && (!best || c.until < best.until)) best = c;
    }
    return best?.error;
  }

  /** Put key #index in cooldown for the failure; returns the cooldown in ms. */
  mark(index: number, bucket: string, failure: KeyFailure, error: unknown): number {
    const now = this.now();
    let ms: number;
    let id = `${index}:${bucket}`;
    if (failure.kind === "invalid") {
      ms = COOLDOWN_INVALID_MS;
      id = `${index}:${GLOBAL}`;
    } else if (failure.kind === "overloaded") {
      ms = COOLDOWN_OVERLOAD_MS;
    } else if (failure.scope === "minute") {
      ms = Math.min(
        COOLDOWN_MINUTE_MAX_MS,
        failure.retryAfterSeconds ? failure.retryAfterSeconds * 1000 : COOLDOWN_MINUTE_MS,
      );
    } else {
      const d = new Date(now);
      const nextUtcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      ms = Math.min(COOLDOWN_DAY_MAX_MS, nextUtcMidnight - now);
    }
    ms = Math.max(ms, 1000);
    this.cooldowns.set(id, { until: now + ms, error });
    this.log(
      `key_cooldown ${JSON.stringify({ key: `#${index + 1}`, bucket, reason: failure.kind, seconds: Math.round(ms / 1000) })}`,
    );
    return ms;
  }

  /** Replace every occurrence of a pool key in the error's text fields (defence in depth; keys travel in a header). */
  scrub<E>(err: E): E {
    if (!err || typeof err !== "object") return err;
    const e = err as Record<string, unknown>;
    for (const field of ["message", "url", "responseBody", "stack"]) {
      const v = e[field];
      if (typeof v !== "string") continue;
      let out = v;
      for (const k of this.keys) if (out.includes(k)) out = out.split(k).join("[redacted-key]");
      if (out !== v) {
        try {
          e[field] = out;
        } catch {
          /* read-only */
        }
      }
    }
    return err;
  }

  clear(): void {
    this.cooldowns.clear();
  }
}

/**
 * Runs `fn` with each available key once (round-robin start). A key-level failure (quota, 503, invalid key) moves on
 * to the next key; any other error propagates immediately. When every key failed, the LAST key-level error is
 * rethrown (so the model-fallback layer classifies it as usual). With an empty pool `fn` runs once with index -1
 * (the default provider / environment).
 */
export async function withKeyFailover<T>(
  pool: KeyPool,
  bucket: string,
  fn: (keyIndex: number) => PromiseLike<T>,
): Promise<T> {
  if (pool.size === 0) return fn(-1);
  const order = pool.order(bucket);
  if (order.length === 0) throw pool.scrub(pool.lastCooldownError(bucket) ?? new Error("all_keys_cooling_down"));
  let last: unknown;
  for (const idx of order) {
    try {
      return await fn(idx);
    } catch (err) {
      const failure = classifyKeyError(err);
      if (!failure) throw pool.scrub(err);
      pool.scrub(err);
      pool.mark(idx, bucket, failure, err);
      last = err;
    }
  }
  throw last;
}

let shared: { sig: string; pool: KeyPool } | null = null;

/** The process-wide pool for the keys in `env` (rebuilt only when the key list changes, so cooldowns persist). */
export function getKeyPool(env: Record<string, string | undefined> = process.env): KeyPool {
  const keys = keysFromEnv(env);
  const sig = keys.join("\u0000");
  if (!shared || shared.sig !== sig) shared = { sig, pool: new KeyPool(keys) };
  return shared.pool;
}

/** Provider for key index (-1 = the default provider, which reads GOOGLE_GENERATIVE_AI_API_KEY itself). */
export function googleFor(pool: KeyPool, index: number): GoogleProvider {
  return index < 0 ? google : pool.provider(index);
}
