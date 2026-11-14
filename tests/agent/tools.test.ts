import { afterEach, describe, expect, it, vi } from "vitest";
import { createTools } from "@/lib/agent/tools";
import type { ToolContext } from "@/lib/agent/types";
import { APPT, CONV, OTHER_TENANT, PROVIDER, SERVICE, TENANT, fakeDb, type FakeDbSpec } from "./helpers";

function setup(spec: FakeDbSpec = {}) {
  const f = fakeDb(spec);
  const ctx: ToolContext = {
    db: f.db,
    tenantId: TENANT,
    conversationId: CONV,
    timezone: "Asia/Riyadh",
    locale: "en",
    embedQuery: async () => Array(768).fill(0.01),
  };
  const tools = createTools(ctx);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const run = (name: keyof typeof tools, input: unknown): Promise<any> =>
    (tools[name] as any).execute(input, { toolCallId: "t", messages: [] });
  const validate = (name: keyof typeof tools, input: unknown): any => (tools[name] as any).inputSchema["~standard"].validate(input);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { ...f, tools, run, validate };
}

const future = new Date(Date.now() + 86_400_000).toISOString();
const booking = { service_id: SERVICE, provider_id: PROVIDER, starts_at: future, full_name: "Sara Ali", phone: "+966500000000" };

describe("tool schemas reject cross-tenant / unknown arguments", () => {
  it("every tool refuses a model-supplied tenant id", () => {
    const { validate } = setup();
    const samples = {
      list_services: {},
      list_providers: {},
      check_availability: { service_id: SERVICE, date_from: "2030-01-01" },
      create_booking: { ...booking, user_confirmed: true },
      reschedule_booking: { appointment_id: APPT, new_starts_at: future, user_confirmed: true },
      cancel_booking: { appointment_id: APPT, user_confirmed: true },
      get_my_appointments: {},
      search_knowledge: { query: "parking" },
    } as const;
    for (const [name, sample] of Object.entries(samples)) {
      const n = name as keyof typeof samples;
      expect(validate(n, sample).issues, `${name} accepts valid input`).toBeUndefined();
      for (const key of ["tenant_id", "tenantId", "p_tenant_id"]) {
        expect(validate(n, { ...sample, [key]: OTHER_TENANT }).issues, `${name} must reject ${key}`).toBeDefined();
      }
    }
  });

  it("create_booking needs explicit confirmation", () => {
    const { validate } = setup();
    expect(validate("create_booking", { ...booking, user_confirmed: false }).issues).toBeDefined();
    expect(validate("create_booking", booking).issues).toBeDefined();
  });
});

describe("tools always use the server tenant", () => {
  it("list_*, check_availability, search_knowledge pass ctx.tenantId to SQL", async () => {
    const { run, rpcCalls } = setup({
      rpc: {
        get_available_slots: { data: [] },
        public_list_providers: { data: [] },
        public_list_services: { data: [] },
        match_kb_chunks: { data: [] },
      },
    });
    await run("list_services", {});
    await run("list_providers", { service_id: SERVICE });
    await run("check_availability", { service_id: SERVICE, date_from: "2030-01-01" });
    await run("search_knowledge", { query: "where are you" });
    expect(rpcCalls.length).toBeGreaterThanOrEqual(5);
    for (const c of rpcCalls) expect(c.args.p_tenant_id).toBe(TENANT);
  });

  it("check_availability returns local times and caps the list", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      slot_provider_id: PROVIDER,
      slot_start: new Date(Date.UTC(2030, 0, 1, 6 + (i % 8), 0)).toISOString(),
      slot_end: new Date(Date.UTC(2030, 0, 1, 7, 0)).toISOString(),
    }));
    const { run } = setup({
      rpc: {
        get_available_slots: { data: rows },
        public_list_providers: { data: [{ id: PROVIDER, name_ar: "د. أحمد", name_en: "Dr Ahmed" }] },
      },
    });
    const r = await run("check_availability", { service_id: SERVICE, date_from: "2030-01-01" });
    expect(r.total_found).toBe(30);
    expect(r.slots).toHaveLength(12);
    expect(r.slots[0].provider_name_en).toBe("Dr Ahmed");
    expect(r.slots[0].local).toContain("09:00"); // 06:00Z = 09:00 in Riyadh
  });
});

describe("slot_taken handling", () => {
  it("maps SQLSTATE 23P01 to a retry-with-other-slots result", async () => {
    const { run } = setup({ rpc: { create_public_booking: { error: { code: "23P01", message: "slot_taken" } } } });
    const r = await run("create_booking", { ...booking, user_confirmed: true });
    expect(r).toMatchObject({ ok: false, error: "slot_taken", retry_with_other_slots: true });
    expect(r.message).toMatch(/check_availability/);
  });

  it("maps reschedule slot_taken the same way", async () => {
    const appt = { id: APPT, tenant_id: TENANT, status: "confirmed", starts_at: future };
    const { run } = setup({
      tables: { conversations: { customer_id: "c1" }, customers: { access_token: "tok" } },
      rpc: {
        customer_get_appointments: { data: [appt] },
        customer_reschedule_appointment: { error: { code: "23P01", message: "slot_taken" } },
      },
    });
    const r = await run("reschedule_booking", { appointment_id: APPT, new_starts_at: future, user_confirmed: true });
    expect(r).toMatchObject({ ok: false, error: "slot_taken", retry_with_other_slots: true });
  });

  it.each(["too_far", "too_many_bookings", "invalid_status", "forbidden"])("maps %s to a known error", async (code) => {
    const { run } = setup({ rpc: { create_public_booking: { error: { message: code } } } });
    const r = await run("create_booking", { ...booking, user_confirmed: true });
    expect(r.error).toBe(code);
    expect(r.message).not.toMatch(/went wrong/);
  });

  it("does not leak unknown DB errors", async () => {
    const { run } = setup({ rpc: { create_public_booking: { error: { message: "relation foo secret detail" } } } });
    const r = await run("create_booking", { ...booking, user_confirmed: true });
    expect(r.error).toBe("internal_error");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});

describe("customer-scoped tools", () => {
  it("never returns the customer token and links the conversation when a token is returned", async () => {
    const { run, writes } = setup({
      tables: { customers: { id: "cust-1" } },
      rpc: {
        create_public_booking: {
          data: { appointment_id: APPT, status: "confirmed", starts_at: future, customer_token: "SECRET-TOKEN" },
        },
      },
    });
    const r = await run("create_booking", { ...booking, user_confirmed: true });
    expect(JSON.stringify(r)).not.toContain("SECRET-TOKEN");
    expect(r.manageable_in_chat).toBe(true);
    expect(writes.some((w) => w.table === "conversations" && w.op === "update")).toBe(true);
  });

  it("does not link the conversation when no token is returned (pre-existing customer)", async () => {
    const { run, writes } = setup({
      tables: { customers: { id: "cust-1" } },
      rpc: { create_public_booking: { data: { appointment_id: APPT, status: "confirmed", starts_at: future, customer_token: null } } },
    });
    const r = await run("create_booking", { ...booking, user_confirmed: true });
    expect(r.manageable_in_chat).toBe(false);
    expect(writes.some((w) => w.table === "conversations")).toBe(false);
  });

  it("cannot cancel an appointment of another tenant, even with a valid token", async () => {
    const foreign = { id: APPT, tenant_id: OTHER_TENANT, status: "confirmed", starts_at: future };
    const { run, rpcCalls } = setup({
      tables: { conversations: { customer_id: "c1" }, customers: { access_token: "tok" } },
      rpc: { customer_get_appointments: { data: [foreign] }, customer_cancel_appointment: { data: true } },
    });
    const r = await run("cancel_booking", { appointment_id: APPT, user_confirmed: true });
    expect(r).toMatchObject({ ok: false, error: "appointment_not_found" });
    expect(rpcCalls.some((c) => c.fn === "customer_cancel_appointment")).toBe(false);
  });

  it("cancels an own appointment", async () => {
    const mine = { id: APPT, tenant_id: TENANT, status: "confirmed", starts_at: future };
    const { run, rpcCalls } = setup({
      tables: { conversations: { customer_id: "c1" }, customers: { access_token: "tok" } },
      rpc: { customer_get_appointments: { data: [mine] }, customer_cancel_appointment: { data: true } },
    });
    expect(await run("cancel_booking", { appointment_id: APPT, user_confirmed: true })).toEqual({
      ok: true,
      cancelled: true,
    });
    expect(rpcCalls.find((c) => c.fn === "customer_cancel_appointment")?.args).toMatchObject({ p_token: "tok" });
  });

  it("get_my_appointments is empty when no customer is linked", async () => {
    const { run } = setup({ tables: { conversations: { customer_id: null } } });
    const r = await run("get_my_appointments", {});
    expect(r.appointments).toEqual([]);
  });
});

describe("transient database errors", () => {
  it.each(["40P01", "40001"])("maps SQLSTATE %s to a friendly try-again result, not internal_error", async (code) => {
    const { run } = setup({ rpc: { create_public_booking: { error: { code, message: "deadlock detected" } } } });
    const r = await run("create_booking", { ...booking, user_confirmed: true });
    expect(r).toMatchObject({ ok: false, error: "try_again", retry_same_request: true });
    expect(r.message).toMatch(/try the same call once more/);
    expect(JSON.stringify(r)).not.toContain("deadlock");
  });
  it("still maps 23P01 to slot_taken", async () => {
    const { run } = setup({ rpc: { create_public_booking: { error: { code: "23P01", message: "conflicting key" } } } });
    expect((await run("create_booking", { ...booking, user_confirmed: true })).error).toBe("slot_taken");
  });
});

describe("create_booking at a deposit tenant", () => {
  const held = {
    appointment_id: APPT,
    status: "pending_payment",
    starts_at: future,
    ends_at: future,
    price: 200,
    deposit_amount: 50,
    currency: "SAR",
    payment_expires_at: future,
    customer_token: "cust-secret-token",
  };
  const tenantTbl = (over: Record<string, unknown> = {}) => ({
    id: TENANT,
    slug: "al-noor",
    is_demo: false,
    deposit_enabled: true,
    deposit_type: "fixed",
    deposit_value: 50,
    ...over,
  });
  const env = (kv: Record<string, string>) => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://dawrak.example/");
    for (const [k, v] of Object.entries(kv)) vi.stubEnv(k, v);
  };
  afterEach(() => vi.unstubAllEnvs());

  it("creates the payment row and returns an absolute pay link with only the pay token", async () => {
    env({ PAYMENT_PROVIDER: "moyasar", MOYASAR_SECRET_KEY: "sk_test_x" });
    const { run, writes } = setup({
      tables: { tenants: tenantTbl(), customers: { id: "cust-1" } },
      rpc: { create_public_booking: { data: held } },
    });
    const r = await run("create_booking", { ...booking, user_confirmed: true });
    expect(r.ok).toBe(true);
    const pay = writes.find((w) => w.table === "payments" && w.op === "insert");
    expect(pay?.payload).toMatchObject({
      tenant_id: TENANT,
      appointment_id: APPT,
      amount: 50,
      currency: "SAR",
      status: "pending",
      provider: "moyasar",
    });
    const token = (pay!.payload as { public_token: string }).public_token;
    expect(r.pay_url).toBe(`https://dawrak.example/en/c/al-noor/pay/${token}`);
    expect(r.hold_minutes).toBe(15);
    expect(r.payment_instruction).toMatch(/15 minutes/);
    expect(JSON.stringify(r)).not.toContain("cust-secret-token");
    expect(r.pay_url).not.toMatch(/[?#]/);
  });

  it("creates no payment for a confirmed (non-deposit) booking", async () => {
    env({ PAYMENT_PROVIDER: "moyasar", MOYASAR_SECRET_KEY: "sk_test_x" });
    const { run, writes } = setup({ rpc: { create_public_booking: { data: { ...held, status: "confirmed" } } } });
    const r = await run("create_booking", { ...booking, user_confirmed: true });
    expect(r.pay_url).toBeUndefined();
    expect(writes.some((w) => w.table === "payments")).toBe(false);
  });

  it("a non-demo tenant never gets the fake provider: nothing is booked, honest payments_unavailable", async () => {
    env({ PAYMENT_PROVIDER: "fake" });
    const { run, writes, rpcCalls } = setup({ tables: { tenants: tenantTbl() }, rpc: { create_public_booking: { data: held } } });
    const r = await run("create_booking", { ...booking, user_confirmed: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("payments_unavailable");
    expect(r.message).toMatch(/NO appointment was created/);
    expect(writes.some((w) => w.table === "payments")).toBe(false);
    expect(rpcCalls.some((c) => c.fn === "create_public_booking")).toBe(false);
    expect(rpcCalls.some((c) => c.fn === "check_rate_limit")).toBe(false); // the phone limit is not consumed
  });

  it("production without any payment provider: payments_unavailable, nothing created", async () => {
    env({});
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("PAYMENT_PROVIDER", "");
    vi.stubEnv("MOYASAR_SECRET_KEY", "");
    const { run, rpcCalls } = setup({ tables: { tenants: tenantTbl() }, rpc: { create_public_booking: { data: held } } });
    const r = await run("create_booking", { ...booking, user_confirmed: true });
    expect(r.error).toBe("payments_unavailable");
    expect(rpcCalls.some((c) => c.fn === "create_public_booking")).toBe(false);
  });

  it("a demo tenant may use the fake provider", async () => {
    env({ PAYMENT_PROVIDER: "fake" });
    const { run, writes } = setup({
      tables: { tenants: tenantTbl({ is_demo: true }) },
      rpc: { create_public_booking: { data: held } },
    });
    const r = await run("create_booking", { ...booking, user_confirmed: true });
    expect(writes.find((w) => w.table === "payments")?.payload).toMatchObject({ provider: "fake" });
    expect(r.pay_url).toMatch(/^https:\/\/dawrak\.example\/en\/c\/al-noor\/pay\/[A-Za-z0-9_-]{48}$/);
  });
});

describe("create_booking per-phone daily limit (L4)", () => {
  it("checks a hashed per-tenant/phone bucket (3 per day) BEFORE creating the booking", async () => {
    const { run, rpcCalls } = setup({ rpc: { create_public_booking: { data: { appointment_id: APPT, status: "confirmed" } } } });
    await run("create_booking", { ...booking, phone: "+966 50-000 (0000)", user_confirmed: true });
    const limit = rpcCalls.findIndex((c) => c.fn === "check_rate_limit");
    const create = rpcCalls.findIndex((c) => c.fn === "create_public_booking");
    expect(limit).toBeGreaterThanOrEqual(0);
    expect(limit).toBeLessThan(create);
    expect(rpcCalls[limit].args).toMatchObject({ p_max: 3, p_window: "1 day" });
    const key = String(rpcCalls[limit].args.p_key);
    expect(key).toMatch(new RegExp(`^book-phone:${TENANT}:[0-9a-f]{64}$`));
    expect(key).not.toContain("966");
    // same number written differently (spaces, dashes, brackets) lands in the same bucket
    const again = setup({ rpc: { create_public_booking: { data: { appointment_id: APPT, status: "confirmed" } } } });
    await again.run("create_booking", { ...booking, phone: "+966500000000", user_confirmed: true });
    expect(again.rpcCalls.find((c) => c.fn === "check_rate_limit")!.args.p_key).toBe(key);
  });

  it("over the limit: refuses with a clear tool error and never creates anything", async () => {
    const { run, rpcCalls } = setup({ rpc: { check_rate_limit: { data: false } } });
    const r = await run("create_booking", { ...booking, user_confirmed: true });
    expect(r).toMatchObject({ ok: false, error: "phone_booking_limit" });
    expect(rpcCalls.some((c) => c.fn === "create_public_booking")).toBe(false);
  });
});
