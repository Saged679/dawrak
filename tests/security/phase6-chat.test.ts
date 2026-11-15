import { describe, expect, it } from "vitest";
import { handleChat } from "@/lib/agent/chat-handler";
import { getOrCreateConversation } from "@/lib/agent/conversation";
import { CHAT_LIMITS } from "@/lib/agent/rate-limit";
import { isSameSiteRequest } from "@/lib/security/same-site";
import { DEMO_AUTH_COOKIE_MAX_AGE } from "@/lib/auth/cookie-options";
import { CHAT_SESSION_COOKIE, CHAT_SESSION_MAX_AGE, DEMO_SESSION_MAX_AGE, DEMO_SESSION_COOKIE, chatOwnerHash } from "@/lib/demo/session";
import { retryAfter } from "@/lib/agent/rate-limit";
import { TENANT, fakeDb, scriptedModel, tenantRow } from "../agent/helpers";

const CONV = "11111111-1111-4111-8111-111111111111";
const body = { tenantSlug: "al-noor", locale: "en", message: { type: "text", text: "hello" } };
const post = (headers: Record<string, string>, b: unknown = body) =>
  new Request("http://localhost/api/chat", { method: "POST", headers: { "x-forwarded-for": "1.2.3.4", ...headers }, body: JSON.stringify(b) });

function setup(over: { dayOk?: boolean } = {}) {
  const f = fakeDb({
    tables: { tenants: tenantRow, conversations: { id: CONV } },
    rpc: {
      public_get_tenant: { data: [{ id: TENANT }] },
      check_rate_limit: (a) => ({ data: String(a.p_key).endsWith(":chat:day") && String(a.p_key).startsWith("ip:") ? (over.dayOk ?? true) : true }),
    },
  });
  const model = scriptedModel([{ text: "Hi!" }]);
  return { ...f, model, call: (r: Request) => handleChat(r, { db: f.db, model }) };
}

describe("L2: /api/chat needs JSON and a same-site browser request", () => {
  const json = { "content-type": "application/json" };
  it("refuses a request with neither Origin nor Sec-Fetch-Site", async () => {
    const s = setup();
    const res = await s.call(post(json));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    expect(s.model.doStreamCalls).toHaveLength(0);
  });
  it("refuses a cross-site Sec-Fetch-Site and a foreign Origin", async () => {
    const s = setup();
    expect((await s.call(post({ ...json, "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await s.call(post({ ...json, origin: "https://evil.example", host: "localhost" }))).status).toBe(403);
    expect((await s.call(post({ ...json, origin: "null" }))).status).toBe(403);
  });
  it("refuses a non-JSON Content-Type (form / text posts) with 415", async () => {
    const s = setup();
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
      const res = await s.call(post({ "sec-fetch-site": "same-origin", ...(ct ? { "content-type": ct } : {}) }));
      expect(res.status, ct).toBe(415);
    }
    expect(s.model.doStreamCalls).toHaveLength(0);
  });
  it("accepts same-origin JSON, with or without a charset", async () => {
    const s = setup();
    for (const ct of ["application/json", "application/json; charset=utf-8"]) {
      const res = await s.call(post({ "content-type": ct, "sec-fetch-site": "same-origin" }));
      expect(res.status, ct).toBe(200);
      await res.text();
    }
    const withOrigin = await s.call(post({ ...json, origin: "http://localhost", host: "localhost" }));
    expect(withOrigin.status).toBe(200);
    await withOrigin.text();
  });
  it("isSameSiteRequest mirrors the PDF route rules", () => {
    const r = (h: Record<string, string>) => new Request("http://app.test/x", { method: "POST", headers: h });
    expect(isSameSiteRequest(r({ "sec-fetch-site": "same-site" }))).toBe(true);
    expect(isSameSiteRequest(r({ "sec-fetch-site": "none" }))).toBe(false);
    expect(isSameSiteRequest(r({}))).toBe(false);
    expect(isSameSiteRequest(r({ origin: "http://app.test" }))).toBe(true);
  });
});

describe("L3: per-IP daily chat cap", () => {
  const ok = { "content-type": "application/json", "sec-fetch-site": "same-origin" };
  it("is 60 a day and checked before the model", () => {
    expect(CHAT_LIMITS.ipDay).toMatchObject({ max: 60, window: "1 day" });
  });
  it("answers 429 ip_daily_limit with Retry-After and never reaches the model", async () => {
    const s = setup({ dayOk: false });
    const res = await s.call(post(ok));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("ip_daily_limit");
    const ra = Number(res.headers.get("Retry-After"));
    expect(ra).toBeGreaterThanOrEqual(1);
    expect(ra).toBeLessThanOrEqual(CHAT_LIMITS.ipDay.windowSeconds);
    expect(s.model.doStreamCalls).toHaveLength(0);
  });
});

/** Minimal db that records every .eq() of a conversations lookup and every insert payload. */
function convDb(found: boolean) {
  const eqs: [string, unknown][] = [];
  const inserts: Record<string, unknown>[] = [];
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (c: string, v: unknown) => (eqs.push([c, v]), q);
  q.order = () => q;
  q.limit = () => q;
  q.maybeSingle = async () => ({ data: found ? { id: CONV } : null });
  q.insert = (p: Record<string, unknown>) => (inserts.push(p), q);
  q.single = async () => ({ data: { id: "22222222-2222-4222-8222-222222222222" }, error: null });
  return { db: { from: () => q, rpc: async () => ({ data: null, error: null }) } as never, eqs, inserts };
}

describe("L5: a web conversation is bound to the visitor's session cookie hash", () => {
  const hash = "cd".repeat(32);
  it("resumes by id only together with the session hash", async () => {
    const d = convDb(true);
    expect(await getOrCreateConversation(d.db, { tenantId: TENANT, channel: "web", conversationId: CONV, sessionHash: hash })).toBe(CONV);
    expect(d.eqs).toContainEqual(["session_hash", hash]);
    expect(d.inserts).toHaveLength(0);
  });
  it("a conversation id with NO session never resumes anything (new conversation, id ignored)", async () => {
    const d = convDb(true);
    const id = await getOrCreateConversation(d.db, { tenantId: TENANT, channel: "web", conversationId: CONV, sessionHash: null });
    expect(id).not.toBe(CONV);
    expect(d.eqs).toHaveLength(0);
    expect(d.inserts).toHaveLength(1);
  });
  it("a foreign session finds nothing and gets a fresh conversation stamped with its own hash", async () => {
    const d = convDb(false);
    const id = await getOrCreateConversation(d.db, { tenantId: TENANT, channel: "web", conversationId: CONV, sessionHash: hash });
    expect(id).not.toBe(CONV);
    expect(d.inserts[0]).toMatchObject({ tenant_id: TENANT, channel: "web", session_hash: hash });
  });
  it("whatsapp conversations are not session-bound", async () => {
    const d = convDb(false);
    await getOrCreateConversation(d.db, { tenantId: TENANT, channel: "whatsapp", externalId: "+966500000000" });
    expect(d.inserts[0]).not.toHaveProperty("session_hash");
  });
  it("H1: a real tenant's visitor gets the SEPARATE 30-day chat cookie, never the demo session", async () => {
    const s = setup();
    const res = await s.call(post({ "content-type": "application/json", "sec-fetch-site": "same-origin" }, { ...body, conversationId: CONV }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${CHAT_SESSION_COOKIE}=`);
    expect(cookie).not.toContain(DEMO_SESSION_COOKIE);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain(`Max-Age=${CHAT_SESSION_MAX_AGE}`);
    await res.text();
  });
});

describe("M1: lifetimes", () => {
  it("demo visitor cookies and the session cookie live 6 hours", () => {
    expect(DEMO_AUTH_COOKIE_MAX_AGE).toBe(6 * 3600);
    expect(DEMO_SESSION_MAX_AGE).toBe(6 * 3600);
  });
});

describe("H1: chat owner values are unlinkable across businesses", () => {
  it("the owner hash differs per tenant for the same browser and is never the demo hash", () => {
    const raw = "x".repeat(43);
    const a = chatOwnerHash(raw, "11111111-1111-4111-8111-111111111111");
    const b = chatOwnerHash(raw, "22222222-2222-4222-8222-222222222222");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(a).toBe(chatOwnerHash(raw, "11111111-1111-4111-8111-111111111111"));
  });
});

describe("L1: real Retry-After and checks before limits", () => {
  it("retryAfter is the time left in the epoch-aligned window", () => {
    expect(retryAfter(600, 0)).toBe(600);
    expect(retryAfter(600, 599_000)).toBe(1);
    expect(retryAfter(600, 300_000)).toBe(300);
    expect(retryAfter(86400, 86_399_500)).toBe(1);
  });
  it("a cross-site request is refused before ANY rate limit is counted", async () => {
    const s = setup();
    const res = await s.call(post({ "content-type": "application/json", "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(s.rpcCalls.filter((c) => c.fn === "check_rate_limit")).toHaveLength(0);
    const res2 = await s.call(post({ "content-type": "text/plain", "sec-fetch-site": "same-origin" }));
    expect(res2.status).toBe(415);
    expect(s.rpcCalls.filter((c) => c.fn === "check_rate_limit")).toHaveLength(0);
  });
});
