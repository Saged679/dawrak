import { describe, expect, it, vi } from "vitest";
import { hashArgs, signConfirmation } from "@/lib/agent/confirm";
import { runAgent } from "@/lib/agent/run-agent";
import { CONV, NAME, OTHER_TENANT, PHONE, PROVIDER, SERVICE, TENANT, confirmedMessages, DELIVERED_ID, timed, fakeDb, fullTenantRow, pendingCreate, providerRow, scriptedModel, serviceRow, slotRows, type Step } from "./helpers";

/**
 * Simulates what Gemini really sends (nulls, empty strings, extra and malformed business fields, the old
 * user_confirmed flag, clock times like "5:30 PM") through the REAL runAgent + tools with the AI SDK mock model.
 * Nothing here talks to Gemini. The conversation already holds the visitor's details and their "تأكيد", and a
 * prepare_booking left a pending confirmation in chat_agent_state (issued after the visitor's 2nd message).
 */
const CREATED = {
  appointment_id: "99999999-9999-4999-8999-999999999999",
  status: "confirmed",
  starts_at: "2030-01-01T14:30:00Z",
  ends_at: "2030-01-01T15:00:00Z",
  price: 100,
  currency: "SAR",
  customer_token: null,
};

function setup(steps: Step[], opts: { state?: unknown; extraMessages?: string[]; messages?: typeof confirmedMessages } = {}) {
  const f = fakeDb({
    tables: {
      tenants: fullTenantRow,
      messages: opts.messages ?? timed([{ role: "user", content: confirmedMessages[0].content, parts: null }, { role: "user", content: confirmedMessages[1].content, parts: null }, ...(opts.extraMessages ?? []).map((content) => ({ role: "user", content, parts: null })), { id: DELIVERED_ID, role: "assistant", content: "summary", parts: null }, { role: "user", content: confirmedMessages[3].content, parts: null }]),
      chat_agent_state: opts.state ? { state: opts.state } : null,
    },
    rpc: {
      create_public_booking: { data: CREATED },
      get_available_slots: { data: slotRows },
      public_list_providers: { data: [providerRow] },
      public_list_services: { data: [serviceRow] },
    },
  });
  return { ...f, model: scriptedModel(steps) };
}

async function run(steps: Step[], opts: { onReply?: (t: string) => void; extraMessages?: string[]; pending?: ReturnType<typeof pendingCreate>; text?: string } = {}) {
  const P = opts.pending ?? pendingCreate();
  const d = setup(steps, { state: P.state, extraMessages: opts.extraMessages });
  const res = await runAgent({
    tenantId: TENANT,
    conversationId: CONV,
    message: { type: "text", text: opts.text ?? "ايوه أكد" },
    locale: "ar",
    onReply: opts.onReply,
    deps: { db: d.db, model: d.model },
  });
  await res.consumeStream();
  return { ...d, P, booked: d.rpcCalls.find((c) => c.fn === "create_public_booking") };
}

const call = (input: unknown): Step => ({ toolCalls: [{ name: "create_booking", input }] });
const done: Step = { text: "Done." };
// the token of the pending record that `run` creates (every run builds a fresh one)
const withToken = (extra: Record<string, unknown> = {}, tokenKey: "confirmation_token" | null = "confirmation_token") => (P: ReturnType<typeof pendingCreate>) => ({ ...(tokenKey ? { [tokenKey]: P.token } : {}), ...extra });

async function runWith(input: (P: ReturnType<typeof pendingCreate>) => unknown, more: Step[] = [done], opts: Parameters<typeof run>[1] = {}) {
  const P = opts.pending ?? pendingCreate();
  return run([call(input(P)), ...more], { ...opts, pending: P });
}

describe("create_booking takes only the token; whatever else the model sends is ignored", () => {
  it("baseline: the confirmed call books exactly the stored summary", async () => {
    const r = await runWith(withToken());
    expect(r.booked?.args).toMatchObject({ p_tenant_id: TENANT, p_email: null, p_full_name: NAME, p_phone: PHONE });
    expect(new Date(String(r.booked?.args.p_starts_at)).getTime()).toBe(new Date("2030-01-01T14:30:00Z").getTime());
  });

  it("business fields (even malformed ones) are dropped, never used", async () => {
    const r = await runWith(withToken({ service_id: "nope", provider_id: null, date: "2031-02-03", time: "25:99", full_name: "Evil", phone: 12345, email: "not-an-email", appointment_id: "x" }));
    expect(r.booked?.args).toMatchObject({ p_full_name: NAME, p_phone: PHONE, p_provider_id: PROVIDER, p_service_id: SERVICE, p_email: null });
    expect(new Date(String(r.booked?.args.p_starts_at)).getTime()).toBe(new Date("2030-01-01T14:30:00Z").getTime());
  });

  it("books the stored real email the visitor typed", async () => {
    const P = pendingCreate({ email: "sara@mail-co.dev", issuedAfter: 3 });
    const r = await run([call({ confirmation_token: P.token }), done], { pending: P, extraMessages: ["my email is sara@mail-co.dev"] });
    expect(r.booked?.args.p_email).toBe("sara@mail-co.dev");
  });

  it("a stored email that the visitor never typed is refused at execution (grounding is re-checked)", async () => {
    const P = pendingCreate({ email: "invented@mail-co.dev" });
    const r = await run([call({ confirmation_token: P.token }), done], { pending: P });
    expect(r.booked).toBeUndefined();
  });

  it.each([
    ["starts_at with an offset", { starts_at: "2030-01-01T14:30:00+00:00" }],
    ["starts_at without an offset", { starts_at: "2030-01-01T17:30" }],
    ["a notes field", { notes: "hi" }],
  ])("%s is an unknown key: rejected, nothing booked", async (_n, extra) => {
    const r = await runWith(withToken(extra));
    expect(r.booked).toBeUndefined();
  });

  it.each([true, "true", "yes", false, "false", "", null, 1, "نعم", [], {}])(
    "user_confirmed=%j is ignored: the token and the visitor's message decide",
    async (v) => {
      const withTok = await runWith(withToken({ user_confirmed: v }));
      expect(withTok.booked).toBeDefined();
      const without = await runWith(withToken({ user_confirmed: v }, null));
      expect(without.booked).toBeUndefined();
    },
  );

  it.each(["tenant_id", "tenantId", "p_tenant_id"])("a spoofed %s is rejected, even next to nulls", async (key) => {
    const r = await runWith(withToken({ email: null, [key]: OTHER_TENANT }));
    expect(r.booked).toBeUndefined();
    expect(JSON.stringify(r.rpcCalls)).not.toContain(OTHER_TENANT);
  });

  it("a null tenant_id is still an unknown key (not silently dropped)", async () => {
    const r = await runWith(withToken({ tenant_id: null }));
    expect(r.booked).toBeUndefined();
  });
});

describe("other tools tolerate quirks too", () => {
  it("check_availability: null optionals, a datetime for date_from (alias of date) and an empty date_to", async () => {
    const d = setup([
      { toolCalls: [{ name: "check_availability", input: { service_id: SERVICE, provider_id: null, date_from: "2030-01-01T00:00:00", date_to: "", time: null } }] },
      done,
    ]);
    const res = await runAgent({ tenantId: TENANT, conversationId: CONV, message: { type: "text", text: "x" }, locale: "en", deps: { db: d.db, model: d.model } });
    await res.consumeStream();
    const c = d.rpcCalls.find((x) => x.fn === "get_available_slots");
    expect(c?.args).toMatchObject({ p_provider_id: null, p_date_from: "2030-01-01" });
  });

  it.each([["17:30", "17:30"], ["17:30:00", "17:30"], ["5:30 PM", "17:30"], ["5:30pm", "17:30"]])("prepare_booking reads time %j as business-local %s", async (time, shown) => {
    const d = setup([{ toolCalls: [{ name: "prepare_booking", input: { service_id: SERVICE, provider_id: PROVIDER, date: "2030-01-01T00:00:00", time, full_name: NAME, phone: PHONE, email: null } }] }, done], {
      messages: timed([{ role: "user", content: `${NAME} ${PHONE}`, parts: null }]),
    });
    const res = await runAgent({ tenantId: TENANT, conversationId: CONV, message: { type: "text", text: `${NAME} ${PHONE}` }, locale: "en", deps: { db: d.db, model: d.model } });
    await res.consumeStream();
    const saved = { state: d.stateWrites.at(-1) as { pending: { args: Record<string, string> } } };
    expect(saved.state.pending.args).toMatchObject({ date: "2030-01-01", time: shown });
  });

  it("reschedule_booking executes the stored appointment and time, not the model's", async () => {
    const appt = { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", tenant_id: TENANT, status: "confirmed", starts_at: new Date(Date.now() + 864e5).toISOString() };
    const argsHash = hashArgs({ appointment_id: appt.id, starts_at: "2030-01-01T14:30:00.000Z" });
    const { token, jti, expiresAt } = signConfirmation({ tenantId: TENANT, conversationId: CONV, action: "reschedule_booking", argsHash, userMessageCount: 2 });
    const state = { pending: { action: "reschedule_booking", token, jti, argsHash, summary: "s", args: { appointment_id: appt.id, date: "2030-01-01", time: "17:30" }, expiresAt, delivered_message_id: DELIVERED_ID } };
    const f = fakeDb({
      tables: { tenants: fullTenantRow, conversations: { customer_id: "c1" }, customers: { access_token: "tok" }, messages: confirmedMessages, chat_agent_state: { state } },
      rpc: { customer_get_appointments: { data: [appt] }, customer_reschedule_appointment: { data: { starts_at: "2030-01-01T14:30:00Z" } } },
    });
    const model = scriptedModel([
      { toolCalls: [{ name: "reschedule_booking", input: { appointment_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", date: "2031-05-05", time: "03:00", confirmation_token: token, user_confirmed: "true" } }] },
      done,
    ]);
    const res = await runAgent({ tenantId: TENANT, conversationId: CONV, message: { type: "text", text: "تأكيد" }, locale: "en", deps: { db: f.db, model } });
    await res.consumeStream();
    const c = f.rpcCalls.find((x) => x.fn === "customer_reschedule_appointment");
    expect(c?.args.p_appointment_id).toBe(appt.id);
    expect(new Date(String(c?.args.p_new_starts_at)).toISOString()).toBe("2030-01-01T14:30:00.000Z");
  });
});

describe("invalid input is fed back and the model can retry in the same turn", () => {
  const bad = (P: ReturnType<typeof pendingCreate>) => {
    void P;
    return { confirmation_token: { secret: "Secret Person" } };
  };

  it("recovers: first call invalid, second call corrected, then the final text", async () => {
    const P = pendingCreate();
    const r = await run([call(bad(P)), call({ confirmation_token: P.token }), { text: "تم الحجز" }], { pending: P });
    expect(r.model.doStreamCalls).toHaveLength(3);
    expect(r.booked).toBeDefined();
    const toolMsg = JSON.stringify(r.model.doStreamCalls[1].prompt.at(-1));
    expect(toolMsg).toContain("confirmation_token");
    expect(toolMsg).toContain("call create_booking again");
    expect(toolMsg).not.toContain("Secret Person");
  });

  it("allows one retry after an invalid call even when other tools ran before", async () => {
    const P = pendingCreate();
    const r = await run(
      [
        { toolCalls: [{ name: "get_my_appointments", input: {} }] },
        { toolCalls: [{ name: "search_knowledge", input: { query: "hours" } }] },
        { toolCalls: [{ name: "check_availability", input: { service_id: SERVICE, date_from: "2030-01-01" } }] },
        call(bad(P)),
        call({ confirmation_token: P.token }),
        { text: "ok" },
      ],
      { pending: P },
    );
    expect(r.booked).toBeDefined();
  });

  it("logs only the tool name and zod issue paths/codes, never values", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await run([call(bad(pendingCreate())), done]);
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("create_booking");
      expect(logged).toContain("confirmation_token");
      expect(logged).not.toContain("Secret Person");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not persist a 'technical problem' apology that came from an unresolved validation failure", async () => {
    let saved = "(never called)";
    await run([call(bad(pendingCreate())), { text: "عذراً، حدثت مشكلة تقنية. حاول لاحقاً." }], { onReply: (t) => void (saved = t) });
    expect(saved).not.toMatch(/تقنية/);
    expect(saved).toMatch(/\S/);
  });

  it("keeps a normal assistant reply untouched", async () => {
    let saved = "";
    const P = pendingCreate();
    await run([call({ confirmation_token: P.token }), { text: "تم تأكيد حجزك. نراك قريباً" }], { onReply: (t) => void (saved = t), pending: P });
    expect(saved).toBe("تم تأكيد حجزك. نراك قريباً");
  });
});

