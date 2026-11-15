import { APICallError } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleChat } from "@/lib/agent/chat-handler";
import {
  AssistantQuotaError,
  MEMO_MAX_MS,
  QuotaMemo,
  classifyModelError,
  modelIdsFromEnv,
  thinkingFor,
  type ChainEntry,
} from "@/lib/agent/models";
import { runAgent } from "@/lib/agent/run-agent";
import { CONV, TENANT, fakeDb, tenantRow } from "./helpers";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** The production log line, in the shape @ai-sdk/google throws it. */
const PROD_MESSAGE =
  "You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-2.5-flash\nPlease retry in 19h2m3.5s.";

function geminiError(opts: { status?: number; message?: string; quotaId?: string; retryDelay?: string; bodyStatus?: string } = {}) {
  const status = opts.status ?? 429;
  const body = {
    error: {
      code: status,
      message: opts.message ?? PROD_MESSAGE,
      status: opts.bodyStatus ?? (status === 429 ? "RESOURCE_EXHAUSTED" : status === 404 ? "NOT_FOUND" : "INTERNAL"),
      details: [
        ...(opts.quotaId ? [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: opts.quotaId }] }] : []),
        ...(opts.retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: opts.retryDelay }] : []),
      ],
    },
  };
  return new APICallError({
    message: body.error.message,
    url: "https://generativelanguage.googleapis.com/v1beta/models/x:streamGenerateContent",
    requestBodyValues: {},
    statusCode: status,
    responseBody: JSON.stringify(body),
  });
}

function okModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ] as never[]),
    }),
  });
}
function failingModel(err: () => Error) {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw err();
    },
  });
}

describe("classifyModelError", () => {
  it("the production quota message: per-day free tier, with the retry hint parsed", () => {
    const f = classifyModelError(geminiError());
    expect(f).toEqual({ kind: "quota", scope: "day", retryAfterSeconds: 19 * 3600 + 2 * 60 + 4 });
  });
  it("uses the quotaId and RetryInfo of the JSON payload", () => {
    expect(classifyModelError(geminiError({ message: "x", quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", retryDelay: "19s" }))).toEqual({
      kind: "quota",
      scope: "minute",
      retryAfterSeconds: 19,
    });
    expect(classifyModelError(geminiError({ message: "x", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }))).toMatchObject({
      kind: "quota",
      scope: "day",
    });
  });
  it("a short retry hint without a quota id is a per-minute limit", () => {
    expect(classifyModelError(geminiError({ message: "Resource exhausted. Please retry in 12s." }))).toMatchObject({ scope: "minute", retryAfterSeconds: 12 });
  });
  it("404 is a retired model", () => {
    expect(classifyModelError(geminiError({ status: 404, message: "models/x is not found" }))).toEqual({ kind: "not_found" });
  });
  it("finds the error inside a wrapper (lastError / cause)", () => {
    expect(classifyModelError({ message: "Failed after 3 attempts", lastError: geminiError() })).toMatchObject({ kind: "quota" });
    expect(classifyModelError(Object.assign(new Error("w"), { cause: geminiError() }))).toMatchObject({ kind: "quota" });
  });
  it("5xx and ordinary errors are not quota", () => {
    expect(classifyModelError(geminiError({ status: 503, message: "overloaded" }))).toBeNull();
    expect(classifyModelError(new Error("boom"))).toBeNull();
    expect(classifyModelError(null)).toBeNull();
  });
});

describe("QuotaMemo", () => {
  it("a daily quota is remembered for at most 30 minutes", () => {
    let now = Date.UTC(2030, 0, 1, 10, 0, 0);
    const m = new QuotaMemo(() => now);
    m.mark("a", { kind: "quota", scope: "day" });
    expect(m.blockedFor("a")?.seconds).toBe(MEMO_MAX_MS / 1000);
    now += MEMO_MAX_MS - 1000;
    expect(m.blockedFor("a")).not.toBeNull();
    now += 2000;
    expect(m.blockedFor("a")).toBeNull();
  });
  it("never outlives the next UTC midnight", () => {
    const now = Date.UTC(2030, 0, 1, 23, 50, 0);
    const m = new QuotaMemo(() => now);
    m.mark("a", { kind: "quota", scope: "day" });
    expect(m.blockedFor("a")?.seconds).toBe(600);
  });
  it("a per-minute limit uses the retry hint (capped), default 60 s", () => {
    const m = new QuotaMemo(() => 0);
    m.mark("a", { kind: "quota", scope: "minute", retryAfterSeconds: 19 });
    m.mark("b", { kind: "quota", scope: "minute" });
    m.mark("c", { kind: "quota", scope: "minute", retryAfterSeconds: 99999 });
    expect(m.blockedFor("a")?.seconds).toBe(19);
    expect(m.blockedFor("b")?.seconds).toBe(60);
    expect(m.blockedFor("c")?.seconds).toBe(300);
  });
  it("allBlocked: only when every model is blocked; day scope wins", () => {
    const m = new QuotaMemo(() => 0);
    m.mark("a", { kind: "quota", scope: "minute", retryAfterSeconds: 10 });
    expect(m.allBlocked(["a", "b"])).toBeNull();
    m.mark("b", { kind: "quota", scope: "day" });
    const e = m.allBlocked(["a", "b"]);
    expect(e?.code).toBe("assistant_quota");
    expect(e?.retryAfterSeconds).toBe(10);
    const only = new QuotaMemo(() => 0);
    only.mark("a", { kind: "quota", scope: "minute", retryAfterSeconds: 10 });
    expect(only.allBlocked(["a"])?.code).toBe("assistant_busy");
  });
});

describe("env: model chain and thinking", () => {
  it("primary first, fallbacks in order, deduplicated", () => {
    expect(modelIdsFromEnv({})).toEqual(["gemini-3.5-flash-lite"]);
    expect(modelIdsFromEnv({ GEMINI_MODEL: "a", GEMINI_FALLBACK_MODELS: " b, c ,a,," })).toEqual(["a", "b", "c"]);
  });
  it("thinking: minimal is the default for flash-lite 3.x only; env overrides on gemini-3.x; never on 2.5", () => {
    expect(thinkingFor("gemini-3.5-flash-lite", {})).toBe("minimal");
    expect(thinkingFor("gemini-3.1-flash-lite", {})).toBe("minimal");
    expect(thinkingFor("gemini-2.5-flash", {})).toBeUndefined();
    expect(thinkingFor("gemini-3.6-flash", {})).toBeUndefined();
    expect(thinkingFor("gemini-3.6-flash", { GEMINI_THINKING: "low" })).toBe("low");
    expect(thinkingFor("gemini-3.5-flash-lite", { GEMINI_THINKING: "default" })).toBeUndefined();
    expect(thinkingFor("gemini-2.5-flash", { GEMINI_THINKING: "high" })).toBeUndefined();
    expect(thinkingFor("gemini-3.8-flash", { GEMINI_THINKING: "minimal" })).toBe("low");
    expect(thinkingFor("gemini-3.5-flash-lite", { GEMINI_THINKING: "bogus" })).toBe("minimal");
  });
});

async function run(chain: ChainEntry[], memo = new QuotaMemo()) {
  const d = fakeDb({ tables: { tenants: tenantRow } });
  let reply = "";
  let error: unknown = null;
  const res = await runAgent({
    tenantId: TENANT,
    conversationId: CONV,
    message: { type: "text", text: "hi" },
    locale: "en",
    onReply: (t) => void (reply = t),
    deps: { db: d.db, chain, quotaMemo: memo },
  });
  // surface stream errors instead of the SDK's console noise
  const parts: unknown[] = [];
  for await (const p of res.fullStream) {
    parts.push(p);
    if ((p as { type: string }).type === "error") error = (p as { error: unknown }).error;
  }
  return { reply, error, parts, memo };
}

describe("fallback chain inside runAgent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a quota error on the primary moves to the fallback within the same request, with no retries on the primary", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const primary = failingModel(() => geminiError());
    const fallback = okModel("from fallback");
    const r = await run([
      { id: "p", model: primary },
      { id: "f", model: fallback },
    ]);
    expect(r.reply).toBe("from fallback");
    expect(primary.doStreamCalls).toHaveLength(1); // maxRetries is effectively 0 for quota: no 2 s / 4 s / 8 s backoff
    expect(fallback.doStreamCalls).toHaveLength(1);
  });

  it("404 (retired model) also falls through", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await run([
      { id: "p", model: failingModel(() => geminiError({ status: 404, message: "model not found" })) },
      { id: "f", model: okModel("ok") },
    ]);
    expect(r.reply).toBe("ok");
  });

  it("later requests skip an exhausted model through the memo", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const primary = failingModel(() => geminiError());
    const memo = new QuotaMemo();
    const chain = (): ChainEntry[] => [
      { id: "p", model: primary },
      { id: "f", model: okModel("again") },
    ];
    await run(chain(), memo);
    await run(chain(), memo);
    expect(primary.doStreamCalls).toHaveLength(1);
  });

  it("every model exhausted: AssistantQuotaError (day scope, retry hint), nothing persisted, one call each", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = failingModel(() => geminiError());
    const b = failingModel(() => geminiError());
    const r = await run([
      { id: "a", model: a },
      { id: "b", model: b },
    ]);
    const q = AssistantQuotaError.find(r.error);
    expect(q?.code).toBe("assistant_quota");
    expect(q?.retryAfterSeconds).toBe(19 * 3600 + 2 * 60 + 4);
    expect(a.doStreamCalls).toHaveLength(1);
    expect(b.doStreamCalls).toHaveLength(1);
    expect(r.reply).toBe("");
  });

  it("per-minute exhaustion everywhere is reported as busy, not as today's limit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await run([
      { id: "a", model: failingModel(() => geminiError({ message: "x", quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", retryDelay: "19s" })) },
    ]);
    expect(AssistantQuotaError.find(r.error)?.code).toBe("assistant_busy");
  });

  it("other errors are not swallowed as quota (the SDK still retries 5xx)", async () => {
    const m = failingModel(() => geminiError({ status: 503, message: "overloaded" }));
    const r = await run([{ id: "a", model: m }, { id: "b", model: okModel("never") }]);
    expect(AssistantQuotaError.find(r.error)).toBeNull();
    expect(r.reply).toBe("");
    expect(m.doStreamCalls.length).toBeGreaterThan(1);
  }, 30_000);

  it("sends the thinking level only for models that have one", async () => {
    const lite = okModel("a");
    await run([{ id: "gemini-3.5-flash-lite", model: lite, thinking: "minimal" }]);
    expect(lite.doStreamCalls[0].providerOptions?.google).toMatchObject({ thinkingConfig: { thinkingLevel: "minimal" } });
    const plain = okModel("b");
    await run([{ id: "gemini-2.5-flash", model: plain }]);
    expect(plain.doStreamCalls[0].providerOptions?.google?.thinkingConfig).toBeUndefined();
  });
});

describe("POST /api/chat with an exhausted quota", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const req = () =>
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": "1.2.3.4" },
      body: JSON.stringify({ tenantSlug: "al-noor", locale: "en", message: { type: "text", text: "hello" } }),
    });

  it("fast path: 503 assistant_quota with Retry-After, and the visitor's rate limits are NOT touched", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key-not-real");
    const f = fakeDb({ tables: { tenants: tenantRow } });
    const memo = new QuotaMemo();
    memo.mark("m1", { kind: "quota", scope: "day", retryAfterSeconds: 3600 });
    const res = await handleChat(req(), { db: f.db, quotaMemo: memo, modelIds: ["m1"] });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("assistant_quota");
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(f.rpcCalls.filter((c) => c.fn === "check_rate_limit")).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
  });

  it("per-minute exhaustion answers assistant_busy", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key-not-real");
    const f = fakeDb({ tables: { tenants: tenantRow } });
    const memo = new QuotaMemo();
    memo.mark("m1", { kind: "quota", scope: "minute", retryAfterSeconds: 30 });
    const res = await handleChat(req(), { db: f.db, quotaMemo: memo, modelIds: ["m1"] });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("assistant_busy");
  });

  it("discovered mid-request: the stream carries the assistant_quota code the widget maps", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeDb({
      tables: { tenants: tenantRow, conversations: { id: "11111111-1111-4111-8111-111111111111" } },
      rpc: { public_get_tenant: { data: [{ id: TENANT }] } },
    });
    const res = await handleChat(req(), { db: f.db, model: failingModel(() => geminiError()) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("assistant_quota");
    expect(text).not.toContain("An error occurred");
  });
});
