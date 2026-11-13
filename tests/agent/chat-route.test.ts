import { describe, expect, it } from "vitest";
import { handleChat } from "@/lib/agent/chat-handler";
import { e2eMockEnabled } from "@/lib/agent/mock-gate";
import { CHAT_LIMITS } from "@/lib/agent/rate-limit";
import { WEB_LIMITS } from "@/lib/channels/web";
import { TENANT, fakeDb, scriptedModel, tenantRow } from "./helpers";

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const ok = { tenantSlug: "al-noor", locale: "en", message: { type: "text", text: "hello" } };

function setup(limits: { ip?: boolean; tenant?: boolean } = {}) {
  const f = fakeDb({
    tables: { tenants: tenantRow, conversations: { id: "11111111-1111-4111-8111-111111111111" } },
    rpc: {
      public_get_tenant: { data: [{ id: TENANT }] },
      check_rate_limit: (a) => ({
        data: String(a.p_key).startsWith("ip:") ? (limits.ip ?? true) : (limits.tenant ?? true),
      }),
    },
  });
  const model = scriptedModel([{ text: "Hello!" }]);
  return { ...f, model, call: (r: Request) => handleChat(r, { db: f.db, model }) };
}

describe("POST /api/chat handler", () => {
  it("streams a reply, sets the conversation header and persists both messages", async () => {
    const s = setup();
    const res = await s.call(req(ok));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-conversation-id")).toBeTruthy();
    expect(await res.text()).toContain("Hello!");
    await new Promise((r) => setTimeout(r, 20));
    const roles = s.writes.filter((w) => w.table === "messages").map((w) => (w.payload as { role: string }).role);
    expect(roles).toEqual(["user", "assistant"]);
    const keys = s.rpcCalls.filter((c) => c.fn === "check_rate_limit").map((c) => c.args.p_key);
    expect(keys).toEqual([expect.stringMatching(/^ip:[0-9a-f]{32}:chat$/), `tenant:${TENANT}:chat:day`]);
  });

  it("rejects over the per-IP limit with 429 before touching the model", async () => {
    const s = setup({ ip: false });
    const res = await s.call(req(ok));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("rate_limited");
    expect(res.headers.get("Retry-After")).toBe(String(CHAT_LIMITS.ip.windowSeconds));
    expect(s.model.doStreamCalls).toHaveLength(0);
    expect(s.writes).toHaveLength(0);
  });

  it("rejects over the per-tenant daily limit with 429 before the model", async () => {
    const s = setup({ tenant: false });
    const res = await s.call(req(ok));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("tenant_daily_limit");
    expect(s.model.doStreamCalls).toHaveLength(0);
  });

  it("rejects an over-long message with 413 and does not call the model", async () => {
    const s = setup();
    const res = await s.call(req({ ...ok, message: { type: "text", text: "a".repeat(WEB_LIMITS.maxTextChars + 1) } }));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("message_too_long");
    expect(s.model.doStreamCalls).toHaveLength(0);
  });

  it("rejects an oversize body (declared and actual) and oversize audio", async () => {
    const s = setup();
    expect((await s.call(req(ok, { "content-length": String(WEB_LIMITS.maxBodyBytes + 1) }))).status).toBe(413);
    expect((await s.call(req("x".repeat(WEB_LIMITS.maxBodyBytes + 1)))).status).toBe(413);
    const audio = await s.call(
      req({ ...ok, message: { type: "audio", mediaType: "audio/webm", data: "A".repeat(WEB_LIMITS.maxAudioBase64Chars + 4) } }),
    );
    expect([400, 413]).toContain(audio.status);
    expect(s.model.doStreamCalls).toHaveLength(0);
  });

  it("validates the body: bad json, unknown keys (tenantId), bad locale", async () => {
    const s = setup();
    expect((await s.call(req("{nope"))).status).toBe(400);
    expect((await s.call(req({ ...ok, tenantId: TENANT }))).status).toBe(400);
    expect((await s.call(req({ ...ok, locale: "fr" }))).status).toBe(400);
    expect(s.model.doStreamCalls).toHaveLength(0);
  });

  it("404s an unknown tenant and fails closed if the rate limiter errors", async () => {
    const none = fakeDb({ rpc: { public_get_tenant: { data: [] }, check_rate_limit: { data: true } } });
    const m = scriptedModel([{ text: "x" }]);
    expect((await handleChat(req(ok), { db: none.db, model: m })).status).toBe(404);
    const broken = fakeDb({ rpc: { check_rate_limit: { error: { message: "db down" } } } });
    expect((await handleChat(req(ok), { db: broken.db, model: m })).status).toBe(500);
    expect(m.doStreamCalls).toHaveLength(0);
  });
});

describe("e2e mock model gate", () => {
  const h = (v?: string) => new Headers(v ? { "x-dawrak-e2e-model": v } : {});
  it("ignores the header without the env vars", () => {
    expect(e2eMockEnabled(h("1"), {})).toBe(false);
    expect(e2eMockEnabled(h("1"), { NODE_ENV: "test" })).toBe(false);
  });
  it("needs the header even when the env is set", () => {
    expect(e2eMockEnabled(h(), { DAWRAK_MOCK_CHAT_MODEL: "1", NODE_ENV: "test" })).toBe(false);
  });
  it("is never on for Vercel", () => {
    expect(e2eMockEnabled(h("1"), { DAWRAK_MOCK_CHAT_MODEL: "1", VERCEL: "1", ALLOW_E2E_MOCKS: "true" })).toBe(false);
  });
  it("in production needs ALLOW_E2E_MOCKS=true as well", () => {
    const env = { DAWRAK_MOCK_CHAT_MODEL: "1", NODE_ENV: "production" };
    expect(e2eMockEnabled(h("1"), env)).toBe(false);
    expect(e2eMockEnabled(h("1"), { ...env, ALLOW_E2E_MOCKS: "yes" })).toBe(false);
    expect(e2eMockEnabled(h("1"), { ...env, ALLOW_E2E_MOCKS: "true" })).toBe(true);
  });
  it("the route does not use the mock model when the header is sent without the env vars", async () => {
    const s = setup();
    const res = await handleChat(req(ok, { "x-dawrak-e2e-model": "1" }), { db: s.db });
    // no injected model, no GOOGLE key in tests: the real not_configured answer, never a mock reply
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("not_configured");
  });
});
