import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

/**
 * Model fallback chain for the Gemini free tier (quotas are per model and per day).
 *
 *   GEMINI_MODEL             primary model (default gemini-3.5-flash-lite)
 *   GEMINI_FALLBACK_MODELS   comma-separated, tried in order when the previous one is out of quota (429
 *                            RESOURCE_EXHAUSTED) or gone (404, retired)
 *   GEMINI_THINKING          minimal | low | medium | high | default (see thinkingFor)
 */
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";

export function modelIdsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const ids = [env.GEMINI_MODEL?.trim() || DEFAULT_MODEL];
  for (const id of (env.GEMINI_FALLBACK_MODELS ?? "").split(",")) {
    const t = id.trim();
    if (t && !ids.includes(t)) ids.push(t);
  }
  return ids;
}

const LEVELS = ["minimal", "low", "medium", "high"] as const;
type Level = (typeof LEVELS)[number];

/**
 * Thinking level (providerOptions.google.thinkingConfig.thinkingLevel), per model. Docs (aistudio.google.com/docs/thinking):
 * gemini-3.5-flash-lite and gemini-3.1-flash-lite think at "minimal" by default and support minimal/low/medium/high;
 * "minimal" is NOT supported on gemini-3.8-flash and Gemini 4. gemini-2.5-* use a budget instead, so
 * nothing is sent to them. Unset = "minimal" for the flash-lite 3.x models only (the safe default: it is
 * already their default, we just pin it); any other model keeps its own default unless GEMINI_THINKING names a
 * level, which then applies to every gemini-3.x model. "default" sends nothing.
 */
export function thinkingFor(modelId: string, env: Record<string, string | undefined> = process.env): Level | undefined {
  const raw = env.GEMINI_THINKING?.trim().toLowerCase();
  if (raw === "default" || raw === "off" || raw === "none") return undefined;
  const isGemini3 = /^gemini-3(\.\d+)?-/.test(modelId);
  const isLite3 = /^gemini-3(\.\d+)?-flash-lite/.test(modelId);
  if (raw && (LEVELS as readonly string[]).includes(raw)) {
    if (!isGemini3) return undefined;
    if (raw === "minimal" && /gemini-3\.8-flash(?!-lite)/.test(modelId)) return "low";
    return raw as Level;
  }
  return isLite3 ? "minimal" : undefined;
}

export type ChainEntry = { id: string; model: LanguageModel; thinking?: Level };

export function chainFromEnv(env: Record<string, string | undefined> = process.env): ChainEntry[] {
  return modelIdsFromEnv(env).map((id) => ({ id, model: google(id), thinking: thinkingFor(id, env) }));
}

// ---------------------------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------------------------

export type QuotaScope = "day" | "minute" | "unknown";
export type ModelFailure =
  | { kind: "quota"; scope: QuotaScope; retryAfterSeconds?: number }
  | { kind: "not_found" };

function parseDuration(text: string): number | undefined {
  // "19h2m3.5s", "19s", "500ms"-less forms used by Google: 3.5s, 1h30m
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Math.ceil(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}

type GeminiErrorBody = {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: { "@type"?: string; retryDelay?: string; violations?: { quotaId?: string; quotaMetric?: string }[] }[];
  };
};

function bodyOf(err: unknown): { status?: number; body?: GeminiErrorBody; text: string } {
  const e = err as { statusCode?: number; status?: number; responseBody?: string; data?: unknown; message?: string } | null;
  let body: GeminiErrorBody | undefined;
  if (e?.data && typeof e.data === "object") body = e.data as GeminiErrorBody;
  if (!body && typeof e?.responseBody === "string") {
    try {
      body = JSON.parse(e.responseBody) as GeminiErrorBody;
    } catch {
      /* not JSON */
    }
  }
  return {
    status: e?.statusCode ?? e?.status ?? body?.error?.code,
    body,
    text: `${e?.message ?? ""} ${body?.error?.message ?? ""}`,
  };
}

/** Quota exhaustion (429 / RESOURCE_EXHAUSTED) and retired models (404). Everything else returns null. */
export function classifyModelError(err: unknown, depth = 0): ModelFailure | null {
  if (!err || depth > 4) return null;
  const { status, body, text } = bodyOf(err);
  if (status === 404 || body?.error?.status === "NOT_FOUND") return { kind: "not_found" };
  const exhausted =
    status === 429 || body?.error?.status === "RESOURCE_EXHAUSTED" || /RESOURCE_EXHAUSTED|quota exceeded/i.test(text);
  if (!exhausted) {
    const inner = (err as { lastError?: unknown; cause?: unknown }).lastError ?? (err as { cause?: unknown }).cause;
    return inner ? classifyModelError(inner, depth + 1) : null;
  }
  let retryAfterSeconds: number | undefined;
  let scope: QuotaScope = "unknown";
  for (const d of body?.error?.details ?? []) {
    if (d.retryDelay) retryAfterSeconds = parseDuration(d.retryDelay) ?? retryAfterSeconds;
    for (const v of d.violations ?? []) {
      const id = `${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`;
      if (/PerDay/i.test(id)) scope = "day";
      else if (/PerMinute/i.test(id) && scope !== "day") scope = "minute";
    }
  }
  const hint = /retry in ([0-9hms.]+?)[.\s]*(?:$|[^0-9hms.])/i.exec(text);
  if (retryAfterSeconds === undefined && hint) retryAfterSeconds = parseDuration(hint[1]);
  if (scope === "unknown") {
    if (/per\s*day|daily/i.test(text)) scope = "day";
    else if (/per\s*minute/i.test(text)) scope = "minute";
    else if (retryAfterSeconds !== undefined) scope = retryAfterSeconds > 120 ? "day" : "minute";
    // the production message: "Quota exceeded for metric: ...generate_content_free_tier_requests, limit: 20" (the free tier cap is daily)
    else if (/free_tier_requests/i.test(text)) scope = "day";
  }
  return { kind: "quota", scope, retryAfterSeconds };
}

/** Thrown when no model of the chain can serve the request. Not an APICallError: the SDK never retries it. */
export class AssistantQuotaError extends Error {
  readonly isAssistantQuotaError = true;
  constructor(
    readonly scope: QuotaScope,
    readonly retryAfterSeconds?: number,
  ) {
    super("assistant_quota");
    this.name = "AssistantQuotaError";
  }
  /** Code the widget maps: a per-minute limit is "busy, retry shortly", everything else is today's free limit. */
  get code(): "assistant_quota" | "assistant_busy" {
    return this.scope === "minute" ? "assistant_busy" : "assistant_quota";
  }
  static find(err: unknown, depth = 0): AssistantQuotaError | null {
    if (!err || depth > 4) return null;
    if ((err as { isAssistantQuotaError?: boolean }).isAssistantQuotaError) return err as AssistantQuotaError;
    const inner = (err as { cause?: unknown; lastError?: unknown }).cause ?? (err as { lastError?: unknown }).lastError;
    return AssistantQuotaError.find(inner, depth + 1);
  }
}

// ---------------------------------------------------------------------------------------------
// "Exhausted until" memo (per server instance)
// ---------------------------------------------------------------------------------------------

export const MEMO_MAX_MS = 30 * 60_000;
const MINUTE_DEFAULT_MS = 60_000;
const MINUTE_MAX_MS = 5 * 60_000;

type Entry = { until: number; scope: QuotaScope; retryAfterSeconds?: number };

/**
 * Per-instance, in-memory. Acceptable because it is only an optimisation: it saves a doomed request (and
 * the wait on it) per visitor message. A cold instance, or another instance, simply discovers the exhaustion
 * with one fast 429 and remembers it; nothing depends on the memo being shared or durable. Entries expire after
 * at most 30 minutes (so a reset quota is noticed quickly) and never outlive the next UTC midnight for
 * daily quotas.
 */
export class QuotaMemo {
  private map = new Map<string, Entry>();
  constructor(private now: () => number = Date.now) {}

  mark(id: string, f: ModelFailure): void {
    const now = this.now();
    let ms: number;
    let scope: QuotaScope = "unknown";
    let retryAfterSeconds: number | undefined;
    if (f.kind === "not_found") {
      ms = MEMO_MAX_MS;
    } else {
      scope = f.scope;
      retryAfterSeconds = f.retryAfterSeconds;
      if (f.scope === "minute") {
        ms = Math.min(MINUTE_MAX_MS, f.retryAfterSeconds ? f.retryAfterSeconds * 1000 : MINUTE_DEFAULT_MS);
      } else {
        const d = new Date(now);
        const nextUtcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
        ms = Math.min(MEMO_MAX_MS, nextUtcMidnight - now);
      }
    }
    this.map.set(id, { until: now + Math.max(ms, 1000), scope, retryAfterSeconds });
  }

  /** Seconds left while the model is considered exhausted, else null. */
  blockedFor(id: string): { seconds: number; scope: QuotaScope } | null {
    const e = this.map.get(id);
    if (!e) return null;
    const left = e.until - this.now();
    if (left <= 0) {
      this.map.delete(id);
      return null;
    }
    return { seconds: Math.ceil(left / 1000), scope: e.scope };
  }

  /** When every id is blocked: the quota error to answer with (earliest recovery, day scope wins). */
  allBlocked(ids: string[]): AssistantQuotaError | null {
    if (ids.length === 0) return null;
    const blocks = ids.map((id) => this.blockedFor(id));
    if (blocks.some((b) => b === null)) return null;
    const list = blocks as { seconds: number; scope: QuotaScope }[];
    const scope: QuotaScope = list.some((b) => b.scope !== "minute") ? "day" : "minute";
    return new AssistantQuotaError(scope, Math.min(...list.map((b) => b.seconds)));
  }

  clear(): void {
    this.map.clear();
  }
}

/** Shared by every request handled by this server instance. */
export const sharedQuotaMemo = new QuotaMemo();
