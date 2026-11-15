import { APICallError, generateText, isStepCount, tool } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFallbackModel } from "@/lib/agent/fallback-model";
import {
  COOLDOWN_INVALID_MS,
  KeyPool,
  classifyKeyError,
  getKeyPool,
  keysFromEnv,
  withKeyFailover,
} from "@/lib/agent/key-pool";
import { AssistantQuotaError, QuotaMemo, type ChainEntry } from "@/lib/agent/models";

const SECRET_A = "AIzaSECRET-KEY-AAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET_B = "AQ.SECRET-KEY-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function apiError(status: number, message: string, bodyStatus?: string, extra: object = {}) {
  return new APICallError({
    message,
    url: "https://generativelanguage.googleapis.com/v1beta/models/x:generateContent",
    requestBodyValues: {},
    statusCode: status,
    responseBody: JSON.stringify({ error: { code: status, message, status: bodyStatus, ...extra } }),
  });
}
const quotaDay = () =>
  apiError(429, "Quota exceeded for metric: generate_content_free_tier_requests, limit: 20. Please retry in 19h.", "RESOURCE_EXHAUSTED");
const quotaMinute = () => apiError(429, "Resource exhausted. Please retry in 12s.", "RESOURCE_EXHAUSTED");
const invalidKey = () => apiError(400, "API key not valid. Please pass a valid API key.", "INVALID_ARGUMENT");
const overloaded = () => apiError(503, "The model is overloaded.", "UNAVAILABLE");

const quiet = () => {};
const mk = (keys: string[], now: () => number = () => 0) => new KeyPool(keys, now, quiet);

afterEach(() => vi.restoreAllMocks());

describe("keysFromEnv", () => {
  it("splits, trims, de-duplicates and ignores empty entries", () => {
    expect(keysFromEnv({ GOOGLE_GENERATIVE_AI_API_KEYS: " a , b,,a , c ," })).toEqual(["a", "b", "c"]);
  });
  it("single legacy key still works (sole key)", () => {
    expect(keysFromEnv({ GOOGLE_GENERATIVE_AI_API_KEY: " solo " })).toEqual(["solo"]);
    expect(keysFromEnv({})).toEqual([]);
  });
  it("legacy key is appended after the list without duplicating", () => {
    expect(keysFromEnv({ GOOGLE_GENERATIVE_AI_API_KEYS: "a,b", GOOGLE_GENERATIVE_AI_API_KEY: "b" })).toEqual(["a", "b"]);
    expect(keysFromEnv({ GOOGLE_GENERATIVE_AI_API_KEYS: "a", GOOGLE_GENERATIVE_AI_API_KEY: "z" })).toEqual(["a", "z"]);
  });
});

describe("classifyKeyError", () => {
  it("quota: day vs minute", () => {
    expect(classifyKeyError(quotaDay())).toMatchObject({ kind: "quota", scope: "day" });
    expect(classifyKeyError(quotaMinute())).toMatchObject({ kind: "quota", scope: "minute", retryAfterSeconds: 12 });
  });
  it("503 is overloaded", () => {
    expect(classifyKeyError(overloaded())).toEqual({ kind: "overloaded" });
  });
  it("invalid key (400 API key not valid, 401, 403)", () => {
    expect(classifyKeyError(invalidKey())).toEqual({ kind: "invalid" });
    expect(classifyKeyError(apiError(403, "denied", "PERMISSION_DENIED"))).toEqual({ kind: "invalid" });
    expect(classifyKeyError(apiError(401, "nope"))).toEqual({ kind: "invalid" });
  });
  it("other errors are not key problems", () => {
    expect(classifyKeyError(new Error("boom"))).toBeNull();
    expect(classifyKeyError(apiError(400, "Invalid JSON payload", "INVALID_ARGUMENT"))).toBeNull();
    expect(classifyKeyError(apiError(404, "model not found", "NOT_FOUND"))).toBeNull();
    expect(classifyKeyError(null)).toBeNull();
  });
  it("sees through wrappers", () => {
    expect(classifyKeyError({ message: "Failed after 3 attempts", lastError: quotaDay() })).toMatchObject({ kind: "quota" });
  });
});

describe("withKeyFailover: rotation", () => {
  it("round-robin start spreads load", async () => {
    const pool = mk(["k1", "k2", "k3"]);
    const used: number[] = [];
    for (let i = 0; i < 4; i++) await withKeyFailover(pool, "m", async (k) => void used.push(k));
    expect(used).toEqual([0, 1, 2, 0]);
  });
  it("tries each key once, in order after the start, then succeeds on the next key", async () => {
    const pool = mk(["k1", "k2", "k3"]);
    const tried: number[] = [];
    const r = await withKeyFailover(pool, "m", async (k) => {
      tried.push(k);
      if (k < 2) throw quotaMinute();
      return "ok";
    });
    expect(r).toBe("ok");
    expect(tried).toEqual([0, 1, 2]);
  });
  it("a non-key error propagates immediately without trying other keys", async () => {
    const pool = mk(["k1", "k2"]);
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(withKeyFailover(pool, "m", fn)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("empty pool runs once with index -1", async () => {
    const fn = vi.fn(async (k: number) => k);
    expect(await withKeyFailover(mk([]), "m", fn)).toBe(-1);
  });
});

describe("cooldown", () => {
  it("a quota-minute key is skipped until the cooldown expires", async () => {
    let now = 0;
    const pool = mk(["k1", "k2"], () => now);
    await withKeyFailover(pool, "m", async (k) => {
      if (k === 0) throw quotaMinute();
      return 1;
    });
    // k1 cooling for 12 s (the retry hint); round-robin start would otherwise hit it
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) await withKeyFailover(pool, "m", async (k) => void seen.push(k));
    expect(seen).toEqual([1, 1, 1]);
    now += 13_000;
    expect(pool.order("m")).toContain(0);
  });
  it("cooldown is per model bucket for quota (other models still use the key)", async () => {
    const pool = mk(["k1", "k2"]);
    await withKeyFailover(pool, "m1", async (k) => {
      if (k === 0) throw quotaDay();
      return 1;
    }).catch(() => {});
    expect(pool.order("m1")).toEqual([1]);
    expect(pool.order("m2").sort()).toEqual([0, 1]);
  });
  it("a day-quota key cools for at most 1 hour", () => {
    let now = Date.UTC(2030, 0, 1, 10, 0, 0);
    const pool = mk(["k1", "k2"], () => now);
    pool.mark(0, "m", { kind: "quota", scope: "day" }, quotaDay());
    now += 59 * 60_000;
    expect(pool.order("m")).toEqual([1]);
    now += 2 * 60_000;
    expect(pool.order("m").sort()).toEqual([0, 1]);
  });
  it("a day-quota cooldown never outlives UTC midnight", () => {
    let now = Date.UTC(2030, 0, 1, 23, 50, 0);
    const pool = mk(["k1", "k2"], () => now);
    pool.mark(0, "m", { kind: "quota", scope: "day" }, quotaDay());
    now += 11 * 60_000;
    expect(pool.order("m").sort()).toEqual([0, 1]);
  });
  it("an invalid key is skipped for every model and for a long time", async () => {
    let now = 0;
    const pool = mk(["bad", "good"], () => now);
    const tried: number[] = [];
    await withKeyFailover(pool, "m1", async (k) => {
      tried.push(k);
      if (k === 0) throw invalidKey();
      return 1;
    });
    expect(tried).toEqual([0, 1]);
    expect(pool.order("other-model")).toEqual([1]);
    now += COOLDOWN_INVALID_MS - 1000;
    expect(pool.order("m1")).toEqual([1]);
    now += 2000;
    expect(pool.order("m1").sort()).toEqual([0, 1]);
  });
  it("when every key is cooling, the stored error is rethrown without calling fn", async () => {
    const pool = mk(["k1", "k2"]);
    await withKeyFailover(pool, "m", async () => {
      throw quotaDay();
    }).catch(() => {});
    const fn = vi.fn(async () => 1);
    await expect(withKeyFailover(pool, "m", fn)).rejects.toMatchObject({ statusCode: 429 });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("no key leakage", () => {
  it("rethrown errors are scrubbed and logs carry only the key index", async () => {
    const logs: string[] = [];
    const pool = new KeyPool([SECRET_A, SECRET_B], () => 0, (m) => logs.push(m));
    const leaky = (k: string) =>
      new APICallError({
        message: `quota exceeded for key ${k}`,
        url: `https://x.test/?key=${k}`,
        requestBodyValues: {},
        statusCode: 429,
        responseBody: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: `bad ${k}` } }),
      });
    let err: unknown;
    try {
      await withKeyFailover(pool, "m", async (i) => {
        throw leaky(i === 0 ? SECRET_A : SECRET_B);
      });
    } catch (e) {
      err = e;
    }
    const dump = JSON.stringify({ m: (err as Error).message, u: (err as APICallError).url, b: (err as APICallError).responseBody, logs });
    expect(dump).not.toContain(SECRET_A);
    expect(dump).not.toContain(SECRET_B);
    expect(dump).toContain("#1");
    expect(dump).toContain("#2");
    // errors stored in a cooldown and rethrown later are scrubbed too
    const again = await withKeyFailover(pool, "m", async () => 1).catch((e) => e);
    expect(JSON.stringify({ m: again.message, u: again.url })).not.toContain(SECRET_A);
  });
});

describe("getKeyPool", () => {
  it("is shared for the same key list so cooldowns persist, rebuilt when the list changes", () => {
    const env = { GOOGLE_GENERATIVE_AI_API_KEYS: "a,b" };
    expect(getKeyPool(env)).toBe(getKeyPool({ ...env }));
    expect(getKeyPool({ GOOGLE_GENERATIVE_AI_API_KEY: "solo" })).not.toBe(getKeyPool(env));
  });
});

// ---------------------------------------------------------------------------------------------
// Integration with the model fallback chain
// ---------------------------------------------------------------------------------------------

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const okStream = (text: string) =>
  convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
  ] as never[]);

/** Chain of `ids` where behaviour[id][keyIndex] decides: a thrown error, or "ok". */
function chainOf(plan: Record<string, ("ok" | (() => Error))[]>, calls: string[]): ChainEntry[] {
  return Object.keys(plan).map((id) => ({
    id,
    model: new MockLanguageModelV4({}),
    forKey: (k: number) =>
      new MockLanguageModelV4({
        doStream: async () => {
          calls.push(`${id}#${k + 1}`);
          const step = plan[id][k];
          if (step !== "ok") throw step();
          return { stream: okStream(`from ${id}#${k + 1}`) };
        },
      }),
  }));
}

async function drain(model: ReturnType<typeof createFallbackModel>) {
  const r = await model.doStream({ prompt: [] } as never);
  const reader = r.stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if ((value as { type: string }).type === "text-delta") text += (value as unknown as { delta: string }).delta;
  }
  return text;
}

describe("createFallbackModel with a key pool", () => {
  it("key 1 out of quota: the same model is retried on key 2 (no model switch)", async () => {
    const calls: string[] = [];
    const model = createFallbackModel(chainOf({ m1: [quotaDay, "ok"], m2: ["ok", "ok"] }, calls), {
      memo: new QuotaMemo(),
      pool: mk(["k1", "k2"]),
    });
    expect(await drain(model)).toBe("from m1#2");
    expect(calls).toEqual(["m1#1", "m1#2"]);
  });

  it("all keys exhausted on model 1 falls through to model 2, on the next available key", async () => {
    const calls: string[] = [];
    const model = createFallbackModel(chainOf({ m1: [quotaDay, quotaDay], m2: ["ok", "ok"] }, calls), {
      memo: new QuotaMemo(),
      pool: mk(["k1", "k2"]),
    });
    expect(await drain(model)).toMatch(/^from m2#/);
    expect(calls.slice(0, 2)).toEqual(["m1#1", "m1#2"]);
    expect(calls).toHaveLength(3);
  });

  it("all keys on all models exhausted -> AssistantQuotaError (assistant_quota)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: string[] = [];
    const model = createFallbackModel(chainOf({ m1: [quotaDay, quotaDay], m2: [quotaDay, quotaDay] }, calls), {
      memo: new QuotaMemo(),
      pool: mk(["k1", "k2"]),
    });
    const err = await drain(model).catch((e) => e);
    expect(AssistantQuotaError.find(err)?.code).toBe("assistant_quota");
    expect(calls).toHaveLength(4);
  });

  it("per-minute exhaustion on every key answers assistant_busy", async () => {
    const model = createFallbackModel(chainOf({ m1: [quotaMinute, quotaMinute] }, []), { memo: new QuotaMemo(), pool: mk(["k1", "k2"]) });
    const err = await drain(model).catch((e) => e);
    expect(AssistantQuotaError.find(err)?.code).toBe("assistant_busy");
  });

  it("invalid keys are skipped automatically; a working key serves the request", async () => {
    const calls: string[] = [];
    const pool = mk(["bad1", "bad2", "good"]);
    const model = createFallbackModel(chainOf({ m1: [invalidKey, invalidKey, "ok"] }, calls), { memo: new QuotaMemo(), pool });
    expect(await drain(model)).toBe("from m1#3");
    calls.length = 0;
    // next requests do not even touch the invalid keys
    expect(await drain(model)).toBe("from m1#3");
    expect(calls).toEqual(["m1#3"]);
  });

  it("503 on one key moves to the next key", async () => {
    const calls: string[] = [];
    const model = createFallbackModel(chainOf({ m1: [overloaded, "ok"] }, calls), { memo: new QuotaMemo(), pool: mk(["k1", "k2"]) });
    expect(await drain(model)).toBe("from m1#2");
  });

  it("all keys 503: the 503 propagates unchanged (the SDK's own retries apply)", async () => {
    const model = createFallbackModel(chainOf({ m1: [overloaded, overloaded] }, []), { memo: new QuotaMemo(), pool: mk(["k1", "k2"]) });
    await expect(drain(model)).rejects.toMatchObject({ statusCode: 503 });
  });

  it("single key backward compat: one attempt, then the next model", async () => {
    const calls: string[] = [];
    const model = createFallbackModel(chainOf({ m1: [quotaDay], m2: ["ok"] }, calls), { memo: new QuotaMemo(), pool: mk(["only"]) });
    expect(await drain(model)).toBe("from m2#1");
    expect(calls).toEqual(["m1#1", "m2#1"]);
  });

  it("no retry once the stream has started: a mid-stream failure is not re-sent on another key", async () => {
    const calls: string[] = [];
    const chain: ChainEntry[] = [
      {
        id: "m1",
        model: new MockLanguageModelV4({}),
        forKey: (k) =>
          new MockLanguageModelV4({
            doStream: async () => {
              calls.push(`m1#${k + 1}`);
              return {
                stream: new ReadableStream({
                  start(c) {
                    c.enqueue({ type: "stream-start", warnings: [] });
                    c.enqueue({ type: "text-start", id: "t" });
                    c.enqueue({ type: "text-delta", id: "t", delta: "partial" });
                    c.error(quotaDay());
                  },
                }) as never,
              };
            },
          }),
      },
    ];
    const model = createFallbackModel(chain, { memo: new QuotaMemo(), pool: mk(["k1", "k2"]) });
    await expect(drain(model)).rejects.toBeTruthy();
    expect(calls).toEqual(["m1#1"]);
  });

  it("a failover between steps never re-runs a tool: only the model call is retried", async () => {
    // step 1 (key #1) asks for a tool; step 2 hits quota on the key that is next in rotation, then succeeds on the other key
    let toolRuns = 0;
    const calls: string[] = [];
    const generate = (k: number) =>
      new MockLanguageModelV4({
        doGenerate: async (opts: { prompt: unknown[] }) => {
          calls.push(`#${k + 1}`);
          const hasToolResult = JSON.stringify(opts.prompt).includes("tool-result");
          if (!hasToolResult) {
            return {
              content: [{ type: "tool-call", toolCallId: "c1", toolName: "book", input: JSON.stringify({ x: 1 }) }],
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
              warnings: [],
            } as never;
          }
          if (k === 0) throw quotaMinute();
          return {
            content: [{ type: "text", text: "booked" }],
            finishReason: { unified: "stop", raw: undefined },
            usage,
            warnings: [],
          } as never;
        },
      });
    const chain: ChainEntry[] = [{ id: "m1", model: generate(0), forKey: generate }];
    const pool = mk(["k1", "k2"]);
    // force step 1 onto key #2 (cursor 1), step 2 starts at #1 -> quota -> #2
    pool.order("zzz");
    const model = createFallbackModel(chain, { memo: new QuotaMemo(), pool });
    const result = await generateText({
      model,
      prompt: "book it",
      tools: {
        book: tool({
          inputSchema: z.object({ x: z.number() }),
          execute: async () => {
            toolRuns++;
            return { ok: true };
          },
        }),
      },
      stopWhen: isStepCount(3),
      maxRetries: 0,
    });
    expect(result.text).toBe("booked");
    expect(toolRuns).toBe(1);
    expect(calls).toEqual(["#2", "#1", "#2"]);
  });
});
