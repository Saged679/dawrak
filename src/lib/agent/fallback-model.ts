import type { LanguageModel } from "ai";
import { withKeyFailover, type KeyPool } from "./key-pool";
import { AssistantQuotaError, classifyModelError, QuotaMemo, type ChainEntry, type ModelFailure, type QuotaScope } from "./models";

type LM = Extract<LanguageModel, { specificationVersion: "v4" }>;
type StreamOptions = Parameters<LM["doStream"]>[0];
type GenerateOptions = Parameters<LM["doGenerate"]>[0];

export type FallbackEvent = { model: string; failure: ModelFailure };

/**
 * One LanguageModel that serves a request from the first model of `chain` that is not out of quota.
 *
 * A model failing with a quota error (429 / RESOURCE_EXHAUSTED) or 404 (retired) is remembered in `memo` and
 * the next model is tried IMMEDIATELY, inside doStream. That is also why quota errors are never retried: the
 * error is handled here, before the AI SDK's retry layer (which retries 429 with 2 s/4 s/8 s backoff, useless
 * for a daily quota) ever sees it, and when every model is exhausted an AssistantQuotaError is thrown, which
 * is not an APICallError and so is not retryable either. Other errors (5xx, network) propagate unchanged, so the
 * SDK's normal retries apply to them.
 *
 * doStream only fails before the first byte for these HTTP-level errors (Gemini answers 429 as a normal HTTP
 * response), so switching models never repeats or truncates visible output.
 */
export function createFallbackModel(
  chain: ChainEntry[],
  opts: { memo?: QuotaMemo; pool?: KeyPool; onFallback?: (e: FallbackEvent) => void } = {},
): LM {
  if (chain.length === 0) throw new Error("empty model chain");
  const memo = opts.memo ?? new QuotaMemo();
  const first = chain[0].model as LM;

  async function attempt<T>(call: (e: ChainEntry, model: LanguageModel) => PromiseLike<T>): Promise<T> {
    type Worst = { scope: QuotaScope; retryAfterSeconds?: number };
    let worst: Worst | null = null as Worst | null;
    for (const entry of chain) {
      if (memo.blockedFor(entry.id)) continue;
      try {
        // Per model: every available API key once (key-pool.ts), then the next model. Only the model call is retried
        // (it runs before the SDK executes any tool, and a started stream is never retried), so no tool can run twice.
        const pool = opts.pool;
        return await (pool && pool.size > 0 && entry.forKey
          ? withKeyFailover(pool, entry.id, (i) => call(entry, entry.forKey!(i)))
          : call(entry, entry.model));
      } catch (err) {
        const failure = classifyModelError(err);
        if (!failure) throw err;
        memo.mark(entry.id, failure);
        opts.onFallback?.({ model: entry.id, failure });
        if (failure.kind === "quota") {
          const prev: Worst | null = worst;
          worst = {
            scope: prev?.scope === "day" || failure.scope !== "minute" ? "day" : "minute",
            retryAfterSeconds:
              failure.retryAfterSeconds !== undefined && prev?.retryAfterSeconds !== undefined
                ? Math.min(failure.retryAfterSeconds, prev.retryAfterSeconds)
                : (failure.retryAfterSeconds ?? prev?.retryAfterSeconds),
          };
        }
      }
    }
    // Prefer what Google just told us (the real retry hint) over the memo's capped remaining time.
    throw worst
      ? new AssistantQuotaError(worst.scope, worst.retryAfterSeconds)
      : (memo.allBlocked(chain.map((c) => c.id)) ?? new AssistantQuotaError("unknown"));
  }

  const withThinking = <O extends { providerOptions?: StreamOptions["providerOptions"] }>(o: O, e: ChainEntry): O => {
    if (!e.thinking) return o;
    const google = { ...(o.providerOptions?.google ?? {}) } as Record<string, unknown>;
    google.thinkingConfig = { ...((google.thinkingConfig as object | undefined) ?? {}), thinkingLevel: e.thinking };
    return { ...o, providerOptions: { ...o.providerOptions, google } } as O;
  };

  return {
    specificationVersion: first.specificationVersion,
    provider: "dawrak-fallback",
    modelId: chain.map((c) => c.id).join(">"),
    supportedUrls: first.supportedUrls,
    doStream: (o: StreamOptions) => attempt((e, m) => (m as LM).doStream(withThinking(o, e) as StreamOptions)),
    doGenerate: (o: GenerateOptions) => attempt((e, m) => (m as LM).doGenerate(withThinking(o, e) as GenerateOptions)),
  } as LM;
}
