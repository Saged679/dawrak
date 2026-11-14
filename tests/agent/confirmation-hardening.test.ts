import { describe, expect, it, vi } from "vitest";
import { findPendingSummary } from "@/components/chat/pending-summary";
import { checkToken, deriveConfirmKey, readToken, signConfirmation } from "@/lib/agent/confirm";
import { runAgent } from "@/lib/agent/run-agent";
import { formatStateForPrompt } from "@/lib/agent/state";
import { APPT, CONV, NAME, PHONE, TENANT, bookingArgs, confirmedMessages, fakeDb, fullTenantRow, pendingCreate, providerRow, scriptedModel, serviceRow, slotRows, world } from "./helpers";

/**
 * Hardening after the adversarial review: the token is bound to what the VISITOR saw and agreed to
 * (the stored summary), not to what the model prepared or later sends.
 */
const created = (w: ReturnType<typeof world>) => w.rpcCalls.filter((c) => c.fn === "create_public_booking");

describe("H2: only the very next visitor message can confirm, and stale pending state never pushes the model", () => {
  it("a confirmation that arrives after an intervening turn is stale (the review's 'ok thanks' exploit)", async () => {
    const w = world();
    const { token } = await w.prepared(); // issued at visitor message 2
    const r = await w.turn({ userMessageCount: 4, latest: { type: "text", text: "ok thanks" } }).run("create_booking", { confirmation_token: token });
    expect(r).toMatchObject({ ok: false, error: "confirmation_stale" });
    expect(created(w)).toHaveLength(0);
  });

  it("checkToken reports stale only when the count is not exactly n+1, and same_turn when it did not grow", () => {
    const key = deriveConfirmKey({ CHAT_CONFIRM_SECRET: "Zq8vK2mPx9LdR4nTa7Yw3JhB6cFe5GuS" });
    const base = { tenantId: "t", conversationId: "c", action: "create_booking" as const, argsHash: "h" };
    const { token } = signConfirmation({ ...base, userMessageCount: 5 }, key);
    expect(checkToken(token, { ...base, userMessageCount: 5 }, key)).toMatchObject({ ok: false, reason: "same_turn" });
    expect(checkToken(token, { ...base, userMessageCount: 6 }, key)).toMatchObject({ ok: true });
    expect(checkToken(token, { ...base, userMessageCount: 7 }, key)).toMatchObject({ ok: false, reason: "stale" });
  });

  const agent = async (latest: string, state: unknown, messages = confirmedMessages) => {
    const f = fakeDb({
      tables: { tenants: fullTenantRow, messages, chat_agent_state: { state } },
      rpc: { public_list_services: { data: [serviceRow] }, public_list_providers: { data: [providerRow] }, get_available_slots: { data: slotRows } },
    });
    const model = scriptedModel([{ text: "ok" }]);
    const res = await runAgent({ tenantId: TENANT, conversationId: CONV, message: { type: "text", text: latest }, locale: "en", deps: { db: f.db, model } });
    await res.consumeStream();
    const saved = f.stateWrites as { pending?: unknown }[];
    return { system: JSON.stringify(model.doStreamCalls[0].prompt[0]), saved };
  };

  it.each(["what are your opening hours", "thanks a lot", "لا", "تعديل", "wait", "ايوه بس غير الوقت"])("a non-affirmative latest message (%j) CLEARS the pending record and the model is not pushed", async (text) => {
    const { state } = pendingCreate();
    const r = await agent(text, state);
    expect(r.saved.at(-1)?.pending).toBeNull();
    expect(r.system).not.toContain("pending_action");
    expect(r.system).not.toContain("pending_confirmation_token");
    expect(r.system).not.toContain("Call the pending_action tool NOW");
  });

  it("only an affirmative latest message keeps it and tells the model to execute with ONLY the token", async () => {
    const { state, token } = pendingCreate();
    const r = await agent("تأكيد", state);
    expect(r.system).toContain("pending_action: create_booking");
    expect(r.system).toContain(`pending_confirmation_token: ${token}`);
    expect(r.system).toMatch(/ONLY confirmation_token/);
    expect(r.system).not.toContain("pending_arguments");
  });

  it("an affirmative for ANOTHER action's wording does not keep it: 'تمام الغاء الحجز' clears a pending booking", async () => {
    const { state } = pendingCreate();
    const r = await agent("تمام الغاء الحجز", state);
    expect(r.saved.at(-1)?.pending).toBeNull();
  });

  it("an expired pending record is dropped", async () => {
    const { state } = pendingCreate({ expiresAt: Date.now() - 1000 });
    const r = await agent("تأكيد", state);
    expect(r.system).not.toContain("pending_action");
  });

  it("the state block never pushes execution unless told the latest message was affirmative", () => {
    const { state } = pendingCreate();
    const quiet = formatStateForPrompt(state, Date.now(), false);
    expect(quiet).toContain("awaits the visitor's confirmation");
    expect(quiet).not.toMatch(/NOW|pending_confirmation_token/);
    expect(formatStateForPrompt(state, Date.now(), true)).toMatch(/NOW/);
  });
});

describe("H3: only the CURRENT pending summary can execute", () => {
  it("a token for an older summary is stale after a newer summary was shown (the review's E2)", async () => {
    const w = world();
    const A = await w.prepared(); // 17:30
    const B = await w.prepared({ ...bookingArgs, time: "18:00" }, { userMessageCount: 3, latest: { type: "text", text: "change to 18:00" } });
    expect(B.r.ok).toBe(true);
    const old = await w.turn({ userMessageCount: 4, latest: { type: "text", text: "confirm" } }).run("create_booking", { confirmation_token: A.token });
    expect(old.error).toBe("confirmation_stale");
    expect(created(w)).toHaveLength(0);
    const cur = await w.turn({ userMessageCount: 4, latest: { type: "text", text: "confirm" } }).run("create_booking", { confirmation_token: B.token });
    expect(cur.ok).toBe(true);
    expect(created(w)[0].args.p_starts_at).toBe("2030-01-01T15:00:00.000Z"); // 18:00 Riyadh
  });

  it("a stale quick-reply 'Confirm' only ever confirms the CURRENT pending action: the older summary's token cannot ride on it", async () => {
    const w = world();
    const A = await w.prepared();
    await w.prepared({ ...bookingArgs, time: "18:00" }, { userMessageCount: 3, latest: { type: "text", text: "change to 18:00" } });
    // the visitor taps Confirm (text "Confirm"); a confused model replays A's token
    const r = await w.turn({ userMessageCount: 4, latest: { type: "text", text: "Confirm" } }).run("create_booking", { confirmation_token: A.token });
    expect(r.error).toBe("confirmation_stale");
  });

  it("a failed newer prepare clears the pending record: the older token no longer works", async () => {
    const w = world();
    const A = await w.prepared();
    const bad = await w.turn({ userMessageCount: 3, latest: { type: "text", text: "change the number" } }).run("prepare_booking", { ...bookingArgs, phone: "+966555555555" });
    expect(bad.ok).toBe(false);
    expect(w.state.current.pending).toBeNull();
    const r = await w.turn({ userMessageCount: 4 }).run("create_booking", { confirmation_token: A.token });
    expect(r.error).toBe("confirmation_required");
    expect(created(w)).toHaveLength(0);
  });

  it("a mutating tool of another action cannot use the pending record", async () => {
    const w = world();
    const { token } = await w.prepared();
    expect((await w.turn({}).run("cancel_booking", { confirmation_token: token })).error).toBe("confirmation_required");
    expect((await w.turn({}).run("reschedule_booking", { confirmation_token: token })).error).toBe("confirmation_required");
  });
});

describe("M2: the model's raw variants never reach the database; the stored summary does", () => {
  it("odd name and phone variants are canonicalised in the summary and that is what is executed", async () => {
    const w = world();
    const { r, token } = await w.prepared({ ...bookingArgs, full_name: "SARA...ALI", phone: "+9660500000000" });
    expect(r.ok).toBe(true);
    expect(r.summary_text).toContain("Name: SARA ALI");
    expect(r.summary_text).toContain(`Phone: ${PHONE}`);
    const out = await w.turn({}).run("create_booking", { full_name: "SARA...ALI", phone: "+9660500000000", confirmation_token: token });
    expect(out.ok).toBe(true);
    expect(created(w)[0].args).toMatchObject({ p_full_name: "SARA ALI", p_phone: PHONE });
    expect(String(created(w)[0].args.p_full_name)).not.toContain(".");
    expect(String(created(w)[0].args.p_phone)).not.toContain("0500000000");
  });
  it("a numeric-looking or padded phone is shown as the server will store it", async () => {
    const w = world();
    const { r } = await w.prepared({ ...bookingArgs, phone: "00966 500000000" }, { texts: [`${NAME} 00966 500000000`] });
    expect(r.summary_text).toContain(`Phone: ${PHONE}`);
  });
});

describe("M1 (action-aware): cancellation words confirm ONLY a cancellation", () => {
  it.each(["تمام الغاء الحجز", "اوكي الغاء", "yes cancellation of the booking", "ok cancellation"])("%j does not confirm a booking", async (text) => {
    const w = world();
    const { token } = await w.prepared();
    expect((await w.turn({ latest: { type: "text", text } }).run("create_booking", { confirmation_token: token })).error).toBe("confirmation_not_affirmative");
    expect(created(w)).toHaveLength(0);
  });
  it("but 'confirm the cancellation' / 'اكد الالغاء' do confirm a cancel_booking", async () => {
    const mine = { id: APPT, tenant_id: TENANT, status: "confirmed", starts_at: new Date(Date.now() + 864e5).toISOString(), service_name_en: "S", provider_name_en: "P", service_name_ar: "خ", provider_name_ar: "م" };
    for (const text of ["confirm the cancellation", "اكد الالغاء"]) {
      const w = world({ spec: { tables: { conversations: { customer_id: "c1" }, customers: { access_token: "tok" } }, rpc: { customer_get_appointments: { data: [mine] }, customer_cancel_appointment: { data: true } } } });
      await w.turn({ userMessageCount: 2 }).run("prepare_cancel", { appointment_id: APPT });
      const r = await w.turn({ latest: { type: "text", text } }).run("cancel_booking", { confirmation_token: w.deliver() });
      expect(r, text).toEqual({ ok: true, cancelled: true });
    }
  });
});

describe("L3 / L4: token decoding and the secret", () => {
  const key = deriveConfirmKey({ CHAT_CONFIRM_SECRET: "Zq8vK2mPx9LdR4nTa7Yw3JhB6cFe5GuS" });
  const { token } = signConfirmation({ tenantId: "t", conversationId: "c", action: "create_booking", argsHash: "h", userMessageCount: 1 }, key);
  const [b, s] = token.split(".");
  it("accepts the exact token and rejects padding, whitespace, + and /, wrong case and wrong length", () => {
    expect(readToken(token, key)).not.toBeNull();
    const bad = [`${b}.${s}=`, `${b}.${s.replace(/-/g, "+").replace(/_/g, "/")}`, `${b}.${s.slice(0, 10)} ${s.slice(10)}`, `${b}.${s}*`, `${b}=.${s}`, `${b}.${s.toUpperCase()}`, `${b}.${s.slice(0, 42)}`, ` ${token}`, `${token}\n`, `${b}.${s}.x`];
    for (const t of bad.filter((x) => x !== token)) expect(readToken(t, key), JSON.stringify(t)).toBeNull();
    expect(readToken(`${b}.${s}=`, key)).toBeNull();
  });
  it("CHAT_CONFIRM_SECRET shorter than 32 characters is ignored (the derived fallback is used); 32+ is used", () => {
    const fallback = deriveConfirmKey({ SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-test" });
    expect(deriveConfirmKey({ CHAT_CONFIRM_SECRET: "short-secret", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-test" }).equals(fallback)).toBe(true);
    expect(deriveConfirmKey({ CHAT_CONFIRM_SECRET: "x".repeat(31), SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-test" }).equals(fallback)).toBe(true);
    expect(deriveConfirmKey({ CHAT_CONFIRM_SECRET: "Zq8vK2mPx9LdR4nTa7Yw3JhB6cFe5GuS", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-test" }).equals(fallback)).toBe(false);
  });
  it("a long but low-entropy secret (one repeated character, a few distinct characters) is ignored too", () => {
    const fallback = deriveConfirmKey({ SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-test" });
    for (const secret of ["a".repeat(64), "ab".repeat(32), "1234".repeat(10)]) {
      expect(deriveConfirmKey({ CHAT_CONFIRM_SECRET: secret, SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-test" }).equals(fallback), secret).toBe(true);
    }
    expect(deriveConfirmKey({ CHAT_CONFIRM_SECRET: "Zq8vK2mPx9LdR4nTa7Yw3JhB6cFe5GuS", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-test" }).equals(fallback)).toBe(false);
  });
  it("in production a too-short secret logs one warning that never contains the value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      deriveConfirmKey({ NODE_ENV: "production", CHAT_CONFIRM_SECRET: "super-secret-value", SUPABASE_SERVICE_ROLE_KEY: "k" });
      deriveConfirmKey({ NODE_ENV: "production", CHAT_CONFIRM_SECRET: "super-secret-value", SUPABASE_SERVICE_ROLE_KEY: "k" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain("super-secret-value");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("H1: the visitor sees the SERVER's summary", () => {
  const summary = "Booking summary:\nService: Check-up\nTime: 5:30 PM (17:30)";
  const prep = (over: Record<string, unknown> = {}) => ({ type: "tool-prepare_booking", state: "output-available", output: { ok: true, summary_text: summary, ...over } });

  it("takes the summary from the tool output, verbatim, not from the model's text", () => {
    const msg = { role: "assistant", parts: [prep(), { type: "text", text: "I booked you a haircut tomorrow at 9 for free!" }] };
    expect(findPendingSummary(msg, false)).toBe(summary);
  });
  it("renders no Confirm/Change (null) when summary_text is missing, empty, not a string or the prepare failed", () => {
    for (const out of [{ summary_text: undefined }, { summary_text: "" }, { summary_text: "  " }, { summary_text: 42 }, { ok: false }]) {
      expect(findPendingSummary({ role: "assistant", parts: [prep(out)] }, false), JSON.stringify(out)).toBeNull();
    }
    expect(findPendingSummary({ role: "assistant", parts: [{ type: "text", text: "Please confirm" }] }, false)).toBeNull();
  });
  it("no buttons while the assistant is still streaming, when the newest message is the visitor's, or before the output arrived", () => {
    const m = { role: "assistant", parts: [prep()] };
    expect(findPendingSummary(m, true)).toBeNull();
    expect(findPendingSummary({ role: "user", parts: [{ type: "text", text: "Confirm" }] }, false)).toBeNull();
    expect(findPendingSummary({ role: "assistant", parts: [{ type: "tool-prepare_booking", state: "input-available" }] }, false)).toBeNull();
    expect(findPendingSummary(undefined, false)).toBeNull();
  });
  it("works for prepare_cancel and prepare_reschedule and uses the last prepare of the message", () => {
    expect(findPendingSummary({ role: "assistant", parts: [{ type: "tool-prepare_cancel", state: "output-available", output: { ok: true, summary_text: "Cancel this" } }] }, false)).toBe("Cancel this");
    expect(findPendingSummary({ role: "assistant", parts: [prep(), { type: "tool-prepare_reschedule", state: "output-available", output: { ok: true, summary_text: "Move this" } }] }, false)).toBe("Move this");
  });

  it("the stored assistant message is the server summary followed by the model's text", async () => {
    const f = fakeDb({
      tables: { tenants: fullTenantRow, messages: [{ role: "user", content: `I want a check-up. ${NAME} ${PHONE}`, parts: null }] },
      rpc: { public_list_services: { data: [serviceRow] }, public_list_providers: { data: [providerRow] }, get_available_slots: { data: slotRows } },
    });
    const model = scriptedModel([{ toolCalls: [{ name: "prepare_booking", input: bookingArgs }] }, { text: "Done, please confirm." }]);
    let saved = "";
    const res = await runAgent({ tenantId: TENANT, conversationId: CONV, message: { type: "text", text: `I want a check-up. ${NAME} ${PHONE}` }, locale: "en", onReply: (t) => void (saved = t), deps: { db: f.db, model } });
    await res.consumeStream();
    expect(saved.startsWith("Booking summary:")).toBe(true);
    expect(saved).toContain("Time: 5:30 PM (17:30)");
    expect(saved.endsWith("Done, please confirm.")).toBe(true);
  });
});

