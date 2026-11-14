import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handleChat } from "@/lib/agent/chat-handler";
import { instantToLocal } from "@/lib/agent/local-time";
import type { AgentDb } from "@/lib/agent/types";
import type { Step } from "./helpers";

/**
 * REAL handleChat + REAL local Postgres + a scripted model. Nothing here is faked except the model. These tests
 * load state per request (like production), so they exercise run-agent's clearing / delivery / compare-and-set,
 * which the in-memory `world()` tests cannot. Skipped when the local stack is not running.
 */
function localEnv(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    return readFileSync(".env.local", "utf8").match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
  } catch {
    return undefined;
  }
}
const URL_ = localEnv("NEXT_PUBLIC_SUPABASE_URL");
const KEY = localEnv("SUPABASE_SERVICE_ROLE_KEY");
let reachable = false;
if (URL_ && KEY && /127\.0\.0\.1|localhost/.test(URL_)) {
  try {
    reachable = (await fetch(`${URL_}/rest/v1/`, { headers: { apikey: KEY }, signal: AbortSignal.timeout(2000) })).status < 500;
  } catch {
    reachable = false;
  }
}

type Ctx = { system: string; user: string; tool: string | null; n: number };
type Plan = Step & { error?: string };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

/** A scripted model whose every step is decided by a callback that sees the system prompt, the visitor text and the last tool result. */
function makeModel(fn: (c: Ctx) => Promise<Plan> | Plan) {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async ({ prompt }: { prompt: { role: string; content: unknown }[] }) => {
      const system = String(prompt[0]?.content ?? "");
      const lastUser = [...prompt].reverse().find((m) => m.role === "user");
      const user = Array.isArray(lastUser?.content) ? (lastUser!.content as { text?: string }[]).map((c) => c.text ?? "").join("") : String(lastUser?.content ?? "");
      const last = prompt[prompt.length - 1];
      const tool = last.role === "tool" ? JSON.stringify(last.content) : null;
      const s = await fn({ system, user, tool, n: n++ });
      if (s.error) throw new Error(s.error);
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      (s.toolCalls ?? []).forEach((c, i) => parts.push({ type: "tool-call", toolCallId: `call-${n}-${i}`, toolName: c.name, input: JSON.stringify(c.input) }));
      if (s.text) parts.push({ type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: s.text }, { type: "text-end", id: "t1" });
      parts.push({ type: "finish", finishReason: { unified: s.toolCalls?.length ? "tool-calls" : "stop", raw: undefined }, usage });
      return { stream: convertArrayToReadableStream(parts as never[]) };
    },
  });
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const tokenFromSystem = (system: string) => /pending_confirmation_token: (\S+)/.exec(system)?.[1];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!reachable)("overlapping and per-request chat turns (real handleChat, real Postgres)", () => {
  const sb = createClient(URL_!, KEY!, { auth: { persistSession: false } });
  const db = sb as unknown as AgentDb;
  const cleanup: (() => Promise<void>)[] = [];
  // locally every request shares one client IP (forwarded headers are not trusted off Vercel): start each test with fresh rate limits
  beforeEach(async () => {
    await sb.from("rate_limits").delete().like("key", "%");
  });
  afterAll(async () => {
    for (const c of cleanup) await c().catch(() => {});
  });

  async function world() {
    const { data: t } = await sb.from("tenants").select("id, timezone").eq("slug", "demo-salon").single();
    const tenant = t as { id: string; timezone: string };
    const { data: svcs } = await sb.rpc("public_list_services", { p_tenant_id: tenant.id });
    const svc = (svcs as { id: string }[])[0];
    const from = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    const { data: slots } = await sb.rpc("get_available_slots", { p_tenant_id: tenant.id, p_provider_id: null, p_service_id: svc.id, p_date_from: from, p_date_to: to, p_step_min: 30 });
    const rows = slots as { slot_provider_id: string; slot_start: string }[];
    const slot = rows[Math.floor(Math.random() * Math.min(rows.length, 40))];
    const local = instantToLocal(slot.slot_start, tenant.timezone);
    const phone = `+9665${String(10000000 + Math.floor(Math.random() * 89999999))}`;
    const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const w = {
      tenant,
      phone,
      slot,
      local,
      conversationId: "" as string,
      prepareArgs: { service_id: svc.id, provider_id: slot.slot_provider_id, date: local.date, time: local.time, full_name: "Overlap Tester", phone },
      details: `Book ${local.date} at ${local.time} please. I am Overlap Tester, phone ${phone}`,
      ip,
    };
    cleanup.push(async () => {
      const { data: cust } = await sb.from("customers").select("id").eq("tenant_id", tenant.id).eq("phone", phone);
      for (const c of (cust ?? []) as { id: string }[]) {
        await sb.from("appointments").delete().eq("customer_id", c.id);
        await sb.from("customers").delete().eq("id", c.id);
      }
      if (w.conversationId) await sb.from("conversations").delete().eq("id", w.conversationId);
    });
    return w;
  }
  type W = Awaited<ReturnType<typeof world>>;

  const request = (w: W, text: string) =>
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": w.ip },
      body: JSON.stringify({ tenantSlug: "demo-salon", locale: "en", ...(w.conversationId ? { conversationId: w.conversationId } : {}), message: { type: "text", text } }),
    });
  /** Sends one visitor message, consumes the whole reply stream, returns the tool-result text the model saw last. */
  async function send(w: W, text: string, model: ReturnType<typeof makeModel>) {
    const res = await handleChat(request(w, text), { db, model });
    expect(res.status).toBe(200);
    w.conversationId = res.headers.get("x-conversation-id") ?? w.conversationId;
    await res.text();
  }
  /** Starts a message and returns its pending body promise WITHOUT waiting for the stream to end. */
  async function start(w: W, text: string, model: ReturnType<typeof makeModel>) {
    const res = await handleChat(request(w, text), { db, model });
    w.conversationId = res.headers.get("x-conversation-id") ?? w.conversationId;
    return { res, done: res.text() };
  }
  const intro = (w: W) => send(w, w.details, makeModel(() => ({ text: "Hi, which doctor?" })));
  const stateOf = async (w: W) => {
    const { data } = await sb.from("chat_agent_state").select("state, version").eq("conversation_id", w.conversationId).maybeSingle();
    return (data as { state: { pending?: { token: string; jti: string; delivered_message_id?: string; done?: boolean } | null }; version: number } | null) ?? null;
  };
  const customers = async (w: W) => ((await sb.from("customers").select("id").eq("tenant_id", w.tenant.id).eq("phone", w.phone)).data ?? []).length;
  const assistantMessages = async (w: W) => ((await sb.from("messages").select("id, content").eq("conversation_id", w.conversationId).eq("role", "assistant").order("created_at", { ascending: true })).data ?? []) as { id: string; content: string }[];
  async function until<T>(f: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = await f();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error("timeout");
      await sleep(40);
    }
  }
  /** A well-behaved model for turn 1: prepare, then one short sentence (optionally held on a latch). */
  const preparer = (w: W, hold?: Promise<void>, crash = false) =>
    makeModel(async (c) => {
      if (c.n === 0) return { toolCalls: [{ name: "prepare_booking", input: w.prepareArgs }] };
      if (hold) await hold;
      if (crash) return { error: "model crashed" };
      return { text: "Please confirm." };
    });
  /** The visitor says yes; a well-behaved model executes with the token the server hands it (only if it is handed one). */
  const confirmer = (name = "create_booking", seen?: { tool?: string; token?: string }) =>
    makeModel((c) => {
      if (c.n === 0) {
        const token = tokenFromSystem(c.system);
        if (seen) seen.token = token;
        return token ? { toolCalls: [{ name, input: { confirmation_token: token } }] } : { text: "Nothing to confirm yet." };
      }
      if (seen) seen.tool = c.tool ?? "";
      return { text: "ok" };
    });

  it("normal flow: details, prepare (persisted and delivered), then yes books exactly once", async () => {
    const w = await world();
    await intro(w);
    await send(w, "go on", preparer(w));
    const st = await stateOf(w);
    expect(st?.state.pending?.token).toBeTruthy();
    const msgs = await assistantMessages(w);
    expect(st?.state.pending?.delivered_message_id).toBe(msgs.at(-1)!.id); // delivered = the message carrying the summary was persisted
    expect(msgs.at(-1)!.content.startsWith("Booking summary:")).toBe(true);
    expect(msgs.at(-1)!.content).not.toMatch(/[\w-]{20,}\.[\w-]{30,}/); // no token in what the dashboard shows
    const seen: { tool?: string; token?: string } = {};
    await send(w, "تأكيد", confirmer("create_booking", seen));
    expect(seen.token).toBeTruthy();
    expect(seen.tool).toContain('"ok":true');
    expect(await customers(w)).toBe(1);
    const { count } = await sb.from("appointments").select("id", { count: "exact", head: true }).eq("tenant_id", w.tenant.id).eq("starts_at", w.slot.slot_start).eq("provider_id", w.slot.slot_provider_id).neq("status", "cancelled");
    expect(count).toBe(1);
  });

  it("OVERLAP: while request A is still streaming its prepare, an affirmative request B cannot execute it; releasing A then changes nothing", async () => {
    const w = await world();
    await intro(w);
    const latch = deferred();
    const A = await start(w, "go on", preparer(w, latch.promise));
    // A's prepare tool already ran (pending is stored) but the model is still "typing": no assistant message, nothing delivered
    const pendingA = await until(async () => (await stateOf(w))?.state.pending);
    expect(pendingA.delivered_message_id).toBeUndefined();
    expect(await assistantMessages(w)).toHaveLength(1); // only the intro reply

    // B (e.g. sent straight to the API) is an affirmative; an adversarial model even replays A's token read from the database
    const stolen = pendingA.token;
    const seen: { tool?: string } = {};
    const adversary = makeModel((c) => (c.n === 0 ? { toolCalls: [{ name: "create_booking", input: { confirmation_token: stolen } }] } : ((seen.tool = c.tool ?? ""), { text: "ok" })));
    await send(w, "تأكيد", adversary);
    expect(seen.tool).toMatch(/confirmation_required|confirmation_stale/);
    expect(await customers(w)).toBe(0);
    const { count: uses } = await sb.from("chat_confirmation_uses").select("jti", { count: "exact", head: true }).eq("conversation_id", w.conversationId);
    expect(uses).toBe(0);

    // release A: its message is persisted, but its pending record was dropped by B (compare-and-set): nothing is confirmable
    latch.resolve();
    await A.done;
    await until(async () => (await assistantMessages(w)).length >= 3);
    const after = await stateOf(w);
    expect(after?.state.pending ?? null).toBeNull();
    const late = await send(w, "تأكيد", confirmer());
    void late;
    expect(await customers(w)).toBe(0);
  });

  it("a model that crashes after the prepare: whatever the stream did, 'delivered' points exactly at a persisted message and a stolen token still needs the visitor's yes", async () => {
    const w = await world();
    await intro(w);
    await send(w, "go on", preparer(w, undefined, true));
    const st = await stateOf(w);
    const stored = await assistantMessages(w);
    expect(st?.state.pending?.token).toBeTruthy();
    // delivered_message_id is only ever the id of a stored assistant message (the one carrying the summary)
    expect(stored.map((m) => m.id)).toContain(st!.state.pending!.delivered_message_id);
    const stolen = st!.state.pending!.token;
    const seen: { tool?: string } = {};
    // a non-affirmative follow-up drops it, so the stolen token is dead
    await send(w, "hmm let me think", makeModel(() => ({ text: "sure" })));
    await send(w, "تأكيد", makeModel((c) => (c.n === 0 ? { toolCalls: [{ name: "create_booking", input: { confirmation_token: stolen } }] } : ((seen.tool = c.tool ?? ""), { text: "ok" }))));
    expect(seen.tool).toMatch(/confirmation_required|confirmation_stale/);
    expect(await customers(w)).toBe(0);
  });

  it("a client that disconnects before persistence leaves nothing delivered that was not stored", async () => {
    const w = await world();
    await intro(w);
    const latch = deferred();
    const A = await start(w, "go on", preparer(w, latch.promise));
    await until(async () => (await stateOf(w))?.state.pending);
    await A.res.body!.cancel().catch(() => {}); // the visitor closes the tab
    latch.resolve();
    await sleep(400);
    const st = await stateOf(w);
    const stored = await assistantMessages(w);
    // either the message was never stored and nothing is delivered, or it was stored and the delivered id points at exactly that message
    if (stored.length === 1) expect(st?.state.pending?.delivered_message_id).toBeUndefined();
    else expect(st?.state.pending?.delivered_message_id ?? null).toBe(stored.at(-1)!.id);
    // in no case can an affirmative that was not preceded by a delivered summary execute it
    if (!st?.state.pending?.delivered_message_id) {
      const stolen = st?.state.pending?.token ?? "x".repeat(40);
      const seen: { tool?: string } = {};
      await send(w, "تأكيد", makeModel((c) => (c.n === 0 ? { toolCalls: [{ name: "create_booking", input: { confirmation_token: stolen } }] } : ((seen.tool = c.tool ?? ""), { text: "ok" }))));
      expect(await customers(w)).toBe(0);
    }
  });

  it("PER-REQUEST RELOAD: a non-affirmative message clears the pending record in the database; a later yes cannot use the old token", async () => {
    const w = await world();
    await intro(w);
    await send(w, "go on", preparer(w));
    const old = (await stateOf(w))!.state.pending!;
    expect(old.delivered_message_id).toBeTruthy();
    await send(w, "what are your opening hours", makeModel(() => ({ text: "9 to 5" })));
    expect((await stateOf(w))?.state.pending ?? null).toBeNull();
    const seen: { tool?: string } = {};
    await send(w, "تأكيد", makeModel((c) => (c.n === 0 ? { toolCalls: [{ name: "create_booking", input: { confirmation_token: old.token } }] } : ((seen.tool = c.tool ?? ""), { text: "ok" }))));
    expect(seen.tool).toMatch(/confirmation_required|confirmation_stale/);
    expect(await customers(w)).toBe(0);
  });

  it("the state row is compare-and-set: a writer holding a stale version cannot overwrite a newer one", async () => {
    const w = await world();
    await intro(w);
    await send(w, "go on", preparer(w));
    const row = (await stateOf(w))!;
    const win = await sb.from("chat_agent_state").update({ state: { winner: true }, version: row.version + 1 }).eq("conversation_id", w.conversationId).eq("version", row.version).select("version");
    expect(win.data).toHaveLength(1);
    const stale = await sb.from("chat_agent_state").update({ state: { loser: true }, version: row.version + 1 }).eq("conversation_id", w.conversationId).eq("version", row.version).select("version");
    expect(stale.data).toHaveLength(0);
    expect((await stateOf(w))?.state).toEqual({ winner: true });
  });

  describe("cancel end to end (the cancel lexicon, through the real route)", () => {
    async function booked(w: W) {
      await intro(w);
      await send(w, "go on", preparer(w));
      await send(w, "تأكيد", confirmer());
      expect(await customers(w)).toBe(1);
    }
    /** get_my_appointments, then prepare_cancel for the appointment it returned. */
    const cancelPreparer = () =>
      makeModel((c) => {
        if (c.n === 0) return { toolCalls: [{ name: "get_my_appointments", input: {} }] };
        if (c.n === 1) {
          const id = /appointment_id\\?":\\?"([0-9a-f-]{36})/.exec(c.tool ?? "")?.[1];
          return id ? { toolCalls: [{ name: "prepare_cancel", input: { appointment_id: id } }] } : { text: "no appointment" };
        }
        return { text: "Please confirm the cancellation." };
      });
    const statusOf = async (w: W) => {
      const { data: cust } = await sb.from("customers").select("id").eq("tenant_id", w.tenant.id).eq("phone", w.phone);
      const ids = ((cust ?? []) as { id: string }[]).map((c) => c.id);
      return (((await sb.from("appointments").select("status").in("customer_id", ids)).data ?? []) as { status: string }[]).map((r) => r.status);
    };

    it("a booking phrase ('احجز الموعد') after prepare_cancel does NOT cancel", async () => {
      const w = await world();
      await booked(w);
      await send(w, "cancel my booking", cancelPreparer());
      const pending = (await stateOf(w))!.state.pending!;
      expect(pending.delivered_message_id).toBeTruthy();
      const seen: { tool?: string } = {};
      // the model (wrongly) tries to cancel with the real token after a booking phrase
      await send(w, "احجز الموعد", makeModel((c) => (c.n === 0 ? { toolCalls: [{ name: "cancel_booking", input: { confirmation_token: pending.token } }] } : ((seen.tool = c.tool ?? ""), { text: "ok" }))));
      expect(seen.tool).toMatch(/confirmation_required|confirmation_not_affirmative|confirmation_stale/);
      expect(await statusOf(w)).not.toContain("cancelled");
    });

    it.each(["نعم الغي", "Confirm"])("%j after prepare_cancel cancels exactly that appointment", async (yes) => {
      const w = await world();
      await booked(w);
      await send(w, "cancel my booking", cancelPreparer());
      const seen: { tool?: string; token?: string } = {};
      await send(w, yes, confirmer("cancel_booking", seen));
      expect(seen.token).toBeTruthy();
      expect(seen.tool).toContain('"cancelled":true');
      expect(await statusOf(w)).toEqual(["cancelled"]);
    });
  });
});
