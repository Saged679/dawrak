import { describe, expect, it, vi } from "vitest";
import { runAgent } from "@/lib/agent/run-agent";
import { CONV, OTHER_TENANT, PROVIDER, SERVICE, TENANT, fakeDb, scriptedModel, tenantRow, type Step } from "./helpers";

/**
 * Simulates what Gemini really sends (nulls, empty strings, times without seconds/offset, string booleans,
 * extra keys) through the REAL runAgent + tools with the AI SDK mock model. Nothing here talks to Gemini.
 */
const CREATED = {
  appointment_id: "99999999-9999-4999-8999-999999999999",
  status: "confirmed",
  starts_at: "2030-01-01T06:30:00Z",
  ends_at: "2030-01-01T07:00:00Z",
  price: 100,
  currency: "SAR",
  customer_token: null,
};

function setup(steps: Step[]) {
  const f = fakeDb({
    tables: { tenants: tenantRow },
    rpc: { create_public_booking: { data: CREATED } },
  });
  return { ...f, model: scriptedModel(steps) };
}

async function run(steps: Step[], opts: { onReply?: (t: string) => void } = {}) {
  const d = setup(steps);
  const res = await runAgent({
    tenantId: TENANT,
    conversationId: CONV,
    message: { type: "text", text: "ايوه أكد" },
    locale: "ar",
    onReply: opts.onReply,
    deps: { db: d.db, model: d.model },
  });
  await res.consumeStream();
  return { ...d, booked: d.rpcCalls.find((c) => c.fn === "create_public_booking") };
}

const good = {
  service_id: SERVICE,
  provider_id: PROVIDER,
  starts_at: "2030-01-01T09:30:00+03:00",
  full_name: "Sara Ali",
  phone: "+966500000000",
  user_confirmed: true,
};
const call = (input: unknown): Step => ({ toolCalls: [{ name: "create_booking", input }] });
const done: Step = { text: "Done." };

describe("create_booking accepts what Gemini sends", () => {
  it("baseline: the strict, well-formed call books", async () => {
    const r = await run([call(good), done]);
    expect(r.booked?.args).toMatchObject({ p_tenant_id: TENANT, p_email: null });
    expect(new Date(String(r.booked?.args.p_starts_at)).getTime()).toBe(new Date("2030-01-01T06:30:00Z").getTime());
  });

  it.each([
    ["email null", { email: null }],
    ["email empty string", { email: "" }],
    ["email whitespace", { email: "   " }],
  ])("%s becomes 'no email'", async (_n, extra) => {
    const r = await run([call({ ...good, ...extra }), done]);
    expect(r.booked?.args.p_email).toBeNull();
  });

  it("keeps a real email", async () => {
    const r = await run([call({ ...good, email: "sara@example.com" }), done]);
    expect(r.booked?.args.p_email).toBe("sara@example.com");
  });

  it("an invalid non-empty email is still rejected (nothing booked)", async () => {
    const r = await run([call({ ...good, email: "not-an-email" }), done]);
    expect(r.booked).toBeUndefined();
  });

  it.each([
    ["no seconds, no offset (tenant timezone Asia/Riyadh)", "2030-01-01T09:30"],
    ["seconds, no offset", "2030-01-01T09:30:00"],
    ["space instead of T", "2030-01-01 09:30"],
    ["offset without seconds", "2030-01-01T09:30+03:00"],
    ["offset without colon", "2030-01-01T09:30:00+0300"],
    ["Z without seconds", "2030-01-01T06:30Z"],
    ["milliseconds", "2030-01-01T09:30:00.000"],
  ])("starts_at: %s", async (_n, input) => {
    const r = await run([call({ ...good, starts_at: input }), done]);
    expect(new Date(String(r.booked?.args.p_starts_at)).getTime()).toBe(new Date("2030-01-01T06:30:00Z").getTime());
  });

  it.each([true, "true", "TRUE", " yes ", "Yes"])("user_confirmed=%j counts as a confirmation", async (v) => {
    const r = await run([call({ ...good, user_confirmed: v }), done]);
    expect(r.booked).toBeDefined();
  });

  it.each([false, "false", "no", "", null, 1, "1", "y", "نعم", [], {}])(
    "user_confirmed=%j is NEVER a confirmation",
    async (v) => {
      const r = await run([call({ ...good, user_confirmed: v }), done]);
      expect(r.booked).toBeUndefined();
    },
  );

  it("a missing user_confirmed never defaults to true", async () => {
    const rest: Record<string, unknown> = { ...good };
    delete rest.user_confirmed;
    const r = await run([call(rest), done]);
    expect(r.booked).toBeUndefined();
  });

  it("unknown keys are still rejected", async () => {
    const r = await run([call({ ...good, notes: "hi" }), done]);
    expect(r.booked).toBeUndefined();
  });

  it.each(["tenant_id", "tenantId", "p_tenant_id"])("a spoofed %s is rejected, even next to nulls", async (key) => {
    const r = await run([call({ ...good, email: null, [key]: OTHER_TENANT }), done]);
    expect(r.booked).toBeUndefined();
    expect(JSON.stringify(r.rpcCalls)).not.toContain(OTHER_TENANT);
  });

  it("a null tenant_id is still an unknown key (not silently dropped)", async () => {
    const r = await run([call({ ...good, tenant_id: null }), done]);
    expect(r.booked).toBeUndefined();
  });
});

describe("other tools tolerate quirks too", () => {
  it("check_availability: null optionals and a datetime for date_from", async () => {
    const d = setup([
      {
        toolCalls: [
          { name: "check_availability", input: { service_id: SERVICE, provider_id: null, date_from: "2030-01-01T00:00:00", date_to: "" } },
        ],
      },
      done,
    ]);
    const res = await runAgent({
      tenantId: TENANT,
      conversationId: CONV,
      message: { type: "text", text: "x" },
      locale: "en",
      deps: { db: d.db, model: d.model },
    });
    await res.consumeStream();
    const c = d.rpcCalls.find((x) => x.fn === "get_available_slots");
    expect(c?.args).toMatchObject({ p_provider_id: null, p_date_from: "2030-01-01" });
  });

  it("list_providers: service_id null", async () => {
    const d = setup([{ toolCalls: [{ name: "list_providers", input: { service_id: null } }] }, done]);
    const res = await runAgent({
      tenantId: TENANT,
      conversationId: CONV,
      message: { type: "text", text: "x" },
      locale: "en",
      deps: { db: d.db, model: d.model },
    });
    await res.consumeStream();
    expect(d.rpcCalls.find((x) => x.fn === "public_list_providers")?.args).toMatchObject({ p_service_id: null });
  });

  it("reschedule_booking: new_starts_at without offset uses the tenant timezone", async () => {
    const appt = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      tenant_id: TENANT,
      status: "confirmed",
      starts_at: new Date(Date.now() + 864e5).toISOString(),
    };
    const f = fakeDb({
      tables: { tenants: tenantRow, conversations: { customer_id: "c1" }, customers: { access_token: "tok" } },
      rpc: {
        customer_get_appointments: { data: [appt] },
        customer_reschedule_appointment: { data: { starts_at: "2030-01-01T06:30:00Z" } },
      },
    });
    const model = scriptedModel([
      {
        toolCalls: [
          { name: "reschedule_booking", input: { appointment_id: appt.id, new_starts_at: "2030-01-01T09:30", user_confirmed: "true" } },
        ],
      },
      done,
    ]);
    const res = await runAgent({
      tenantId: TENANT,
      conversationId: CONV,
      message: { type: "text", text: "x" },
      locale: "en",
      deps: { db: f.db, model },
    });
    await res.consumeStream();
    const c = f.rpcCalls.find((x) => x.fn === "customer_reschedule_appointment");
    expect(new Date(String(c?.args.p_new_starts_at)).toISOString()).toBe("2030-01-01T06:30:00.000Z");
  });
});

describe("invalid input is fed back and the model can retry in the same turn", () => {
  it("recovers: first call invalid, second call corrected, then the final text", async () => {
    const r = await run([call({ ...good, full_name: undefined }), call(good), { text: "تم الحجز" }]);
    expect(r.model.doStreamCalls).toHaveLength(3);
    expect(r.booked).toBeDefined();
    // the model saw a clear, field-level error and no raw values
    const toolMsg = JSON.stringify(r.model.doStreamCalls[1].prompt.at(-1));
    expect(toolMsg).toContain("full_name");
    expect(toolMsg).toContain("call create_booking again");
    expect(toolMsg).not.toContain("+966500000000");
    expect(toolMsg).not.toContain("Sara Ali");
  });

  it("allows one retry after an invalid call even when other tools ran before", async () => {
    const r = await run([
      { toolCalls: [{ name: "list_services", input: {} }] },
      { toolCalls: [{ name: "list_providers", input: {} }] },
      { toolCalls: [{ name: "get_my_appointments", input: {} }] },
      { toolCalls: [{ name: "check_availability", input: { service_id: SERVICE, date_from: "2030-01-01" } }] },
      call({ ...good, phone: undefined }),
      call(good),
      { text: "ok" },
    ]);
    expect(r.booked).toBeDefined();
  });

  it("logs only the tool name and zod issue paths/codes, never values", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await run([call({ ...good, full_name: "Secret Person", phone: undefined, email: "bad-email" }), done]);
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("create_booking");
      expect(logged).toContain("phone");
      expect(logged).not.toContain("Secret Person");
      expect(logged).not.toContain("bad-email");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not persist a 'technical problem' apology that came from an unresolved validation failure", async () => {
    let saved = "(never called)";
    await run([call({ ...good, full_name: undefined }), { text: "عذراً، حدثت مشكلة تقنية. حاول لاحقاً." }], {
      onReply: (t) => void (saved = t),
    });
    expect(saved).not.toMatch(/تقنية/);
    expect(saved).toMatch(/\S/);
  });

  it("keeps a normal assistant reply untouched", async () => {
    let saved = "";
    await run([call(good), { text: "تم تأكيد حجزك. نراك قريباً" }], { onReply: (t) => void (saved = t) });
    expect(saved).toBe("تم تأكيد حجزك. نراك قريباً");
  });
});
