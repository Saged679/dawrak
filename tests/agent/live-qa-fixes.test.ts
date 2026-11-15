import { describe, expect, it } from "vitest";
import { holdUntilPersisted } from "@/lib/agent/chat-handler";
import { buildSystemPrompt } from "@/lib/agent/prompt";
import { runAgent } from "@/lib/agent/run-agent";
import { claimsActionDone, guardReply, TurnState } from "@/lib/agent/turn-guard";
import { CONV, DELIVERED_ID, TENANT, confirmedMessages, fakeDb, fullTenantRow, pendingCreate, providerRow, scriptedModel, serviceRow, slotRows, tenantRow, type Step } from "./helpers";

/** Regression tests for the live QA with real Gemini (invented token, false success, persistence ordering, prompt rules). */

const CREATED = { appointment_id: "99999999-9999-4999-8999-999999999999", status: "confirmed", starts_at: "2030-01-01T14:30:00Z", ends_at: "2030-01-01T15:00:00Z", price: 100, currency: "SAR", customer_token: null };

function world(messages: unknown, state?: unknown) {
  return fakeDb({
    tables: { tenants: fullTenantRow, messages, chat_agent_state: state ? { state } : null },
    rpc: { create_public_booking: { data: CREATED }, get_available_slots: { data: slotRows }, public_list_providers: { data: [providerRow] }, public_list_services: { data: [serviceRow] } },
  });
}

async function wire(res: Awaited<ReturnType<typeof runAgent>>) {
  const chunks: string[] = [];
  const reader = res.toUIMessageStream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(JSON.stringify(value));
  }
  return chunks.join("\n");
}

describe("bug 1: the model invents the confirmation token", () => {
  const P = pendingCreate();
  const book = (input: unknown): Step => ({ toolCalls: [{ name: "create_booking", input }] });
  it.each([{ confirmation_token: "INVENTED-TOKEN-123" }, { confirmation_token: `${"a".repeat(40)}.${"B".repeat(43)}` }, {}])(
    "a delivered pending summary + an affirmative next message still books with %j (the server's own token is used)",
    async (input) => {
      const f = world(confirmedMessages, P.state);
      const res = await runAgent({ tenantId: TENANT, conversationId: CONV, message: { type: "text", text: "تأكيد" }, locale: "ar", deps: { db: f.db, model: scriptedModel([book(input), { text: "x" }]) } });
      await res.consumeStream();
      expect(f.rpcCalls.filter((c) => c.fn === "create_public_booking")).toHaveLength(1);
    },
  );
  it("the fallback does not open the gate: a non-affirmative message drops the pending record and nothing is booked", async () => {
    const f = world(confirmedMessages, P.state);
    const res = await runAgent({ tenantId: TENANT, conversationId: CONV, message: { type: "text", text: "what are the prices?" }, locale: "en", deps: { db: f.db, model: scriptedModel([book({ confirmation_token: "invented" }), { text: "x" }]) } });
    await res.consumeStream();
    expect(f.rpcCalls.some((c) => c.fn === "create_public_booking")).toBe(false);
  });
  it("an undelivered pending summary is not usable even with the server token", async () => {
    const undelivered = { pending: { ...P.state.pending, delivered_message_id: undefined } };
    const f = world(confirmedMessages, undelivered);
    const res = await runAgent({ tenantId: TENANT, conversationId: CONV, message: { type: "text", text: "تأكيد" }, locale: "ar", deps: { db: f.db, model: scriptedModel([book({}), { text: "x" }]) } });
    await res.consumeStream();
    expect(f.rpcCalls.some((c) => c.fn === "create_public_booking")).toBe(false);
  });
});

describe("bug 1b: persistence ordering (the stream may not end before the reply + delivered mark are stored)", () => {
  it("holdUntilPersisted keeps the body open until the persistence promise settles", async () => {
    let release!: () => void;
    const persisted = new Promise<void>((r) => (release = r));
    const res = holdUntilPersisted(new Response("hello"), () => persisted);
    const reader = res.body!.getReader();
    let ended = false;
    const finished = (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      ended = true;
    })();
    await new Promise((r) => setTimeout(r, 30));
    expect(ended).toBe(false);
    release();
    await finished;
    expect(ended).toBe(true);
  });
  it("holdUntilPersisted never hangs: it gives up after the bound", async () => {
    const res = holdUntilPersisted(new Response("x"), () => new Promise<void>(() => {}), 20);
    expect(await res.text()).toBe("x");
  });
  it("runAgent settles the registered promise only after onReply (and the delivered mark) finished", async () => {
    const f = fakeDb({
      tables: { tenants: fullTenantRow, messages: confirmedMessages.slice(0, 2) },
      rpc: { public_list_services: { data: [serviceRow] }, public_list_providers: { data: [providerRow] }, get_available_slots: { data: slotRows } },
    });
    let settled = false;
    let replied = false;
    const res = await runAgent({
      tenantId: TENANT,
      conversationId: CONV,
      message: { type: "text", text: "x" },
      locale: "en",
      registerPersistence: (p) => void p.then(() => (settled = true)),
      onReply: async () => {
        await new Promise((r) => setTimeout(r, 40));
        replied = true;
        return DELIVERED_ID;
      },
      deps: { db: f.db, model: scriptedModel([{ text: "Hi" }]) },
    });
    await res.consumeStream();
    await new Promise((r) => setTimeout(r, 120));
    expect(replied).toBe(true);
    expect(settled).toBe(true);
  });
});

describe("bug 2: false success after a refused mutating tool", () => {
  const resched: Step = { toolCalls: [{ name: "reschedule_booking", input: { confirmation_token: "made-up" } }] };
  const claim = { text: "تم نقل موعدك بنجاح" };
  it("the Arabic claim 'تم نقل موعدك بنجاح' is a recognised claim", () => expect(claimsActionDone("تم نقل موعدك بنجاح")).toBe(true));
  it("neither the streamed text nor the stored reply claims success; both say nothing was changed", async () => {
    const f = world(confirmedMessages);
    let stored = "";
    const res = await runAgent({ tenantId: TENANT, conversationId: CONV, message: { type: "text", text: "تأكيد" }, locale: "ar", onReply: (t) => void (stored = t), deps: { db: f.db, model: scriptedModel([resched, claim]) } });
    const w = await wire(res);
    await new Promise((r) => setTimeout(r, 10));
    expect(w).not.toContain("بنجاح");
    expect(w).toContain("لم يتم تنفيذ الطلب");
    expect(stored).not.toContain("بنجاح");
    expect(stored).toContain("لم يتم تنفيذ الطلب");
  });
  it("English claims are replaced too", () => {
    const t = new TurnState();
    t.record("reschedule_booking", "fail");
    expect(guardReply("Your appointment has been successfully moved!", t).text).toMatch(/has not gone through/);
    expect(guardReply("All done!", t).text).toMatch(/has not gone through/);
  });
  it("an honest reply after a refusal is kept, and a real success is never replaced", () => {
    const bad = new TurnState();
    bad.record("create_booking", "fail");
    expect(guardReply("Nothing was changed, please confirm again.", bad).text).toBe("Nothing was changed, please confirm again.");
    const good = new TurnState();
    good.record("create_booking", "ok");
    expect(guardReply("تم الحجز بنجاح", good).text).toBe("تم الحجز بنجاح");
  });
});

describe("bugs 3 and 4: prompt rules", () => {
  const p = (locale: "ar" | "en") => buildSystemPrompt(tenantRow as never, locale, new Date("2026-11-15T10:00:00Z"), {});
  it("forces the visitor's language and translation of knowledge-base text", () => {
    expect(p("en")).toMatch(/ALWAYS translate that content into the reply language/);
    expect(p("en")).toMatch(/never gets Arabic sentences/);
  });
  it("requires search_knowledge for business info and keeps neutral Arabic", () => {
    expect(p("ar")).toMatch(/ALWAYS call search_knowledge BEFORE answering any question about the business itself: opening hours/);
    expect(p("ar")).toMatch(/neutral Arabic/);
    expect(p("ar")).toMatch(/Do NOT drift into another dialect/);
  });
  it("tells the model not to invent tokens or ids and not to claim success after a refusal", () => {
    expect(p("en")).toMatch(/NEVER invent a token or an appointment id/);
    expect(p("en")).toMatch(/NOTHING was done/);
  });
});

describe("review follow-ups: the guard never rewrites a real success", () => {
  it("create ok, then a duplicate create refused: the success reply stays", () => {
    const t = new TurnState();
    t.record("create_booking", "ok");
    t.record("create_booking", "fail");
    expect(guardReply("تم حجز موعدك بنجاح", t).text).toBe("تم حجز موعدك بنجاح");
  });
  it("create ok, then a refused cancel: the success reply stays", () => {
    const t = new TurnState();
    t.record("create_booking", "ok");
    t.record("cancel_booking", "fail");
    expect(guardReply("Your appointment has been booked.", t).text).toBe("Your appointment has been booked.");
  });
  it("end to end: a real booking followed by a replayed create keeps the success text streamed and stored", async () => {
    const P = pendingCreate();
    const f = world(confirmedMessages, P.state);
    let stored = "";
    const call: Step = { toolCalls: [{ name: "create_booking", input: {} }] };
    const res = await runAgent({ tenantId: TENANT, conversationId: CONV, message: { type: "text", text: "تأكيد" }, locale: "ar", onReply: (t) => void (stored = t), deps: { db: f.db, model: scriptedModel([call, call, { text: "تم حجز موعدك بنجاح" }]) } });
    const w = await wire(res);
    await new Promise((r) => setTimeout(r, 10));
    expect(f.rpcCalls.filter((c) => c.fn === "create_public_booking")).toHaveLength(1);
    expect(w).toContain("تم حجز موعدك بنجاح");
    expect(stored).toContain("تم حجز موعدك بنجاح");
  });
  it("L1: text written BEFORE the refused tool call in the same step is corrected too", async () => {
    const f = world(confirmedMessages, pendingCreate().state); // confirmable turn, but the model calls the WRONG tool: refused
    const step: Step = { text: "تم نقل موعدك بنجاح", toolCalls: [{ name: "reschedule_booking", input: { confirmation_token: "x" } }] };
    const res = await runAgent({ tenantId: TENANT, conversationId: CONV, message: { type: "text", text: "تأكيد" }, locale: "ar", deps: { db: f.db, model: scriptedModel([step, { text: "" }]) } });
    const w = await wire(res);
    expect(w).not.toContain("بنجاح");
  });
  it("L5: a short mangled token passes the schema and is replaced by the server's token", async () => {
    const P = pendingCreate();
    const f = world(confirmedMessages, P.state);
    const res = await runAgent({ tenantId: TENANT, conversationId: CONV, message: { type: "text", text: "تأكيد" }, locale: "ar", deps: { db: f.db, model: scriptedModel([{ toolCalls: [{ name: "create_booking", input: { confirmation_token: "abc" } }] }, { text: "x" }]) } });
    await res.consumeStream();
    expect(f.rpcCalls.filter((c) => c.fn === "create_public_booking")).toHaveLength(1);
  });
});
