import { afterEach, describe, expect, it, vi } from "vitest";
import { APPT, OTHER_TENANT, PHONE, PROVIDER, SERVICE, TENANT, bookingArgs, fullTenantRow, world, type WorldOpts } from "./helpers";

/** prepare in turn 1, the visitor says yes, create in turn 2: the only way a booking can happen. */
async function book(w: ReturnType<typeof world>, args: Record<string, unknown> = bookingArgs, visitor = {}) {
  const { r, token } = await w.prepared(args, visitor);
  if (!r.ok) return r;
  return w.turn({}).run("create_booking", { ...args, confirmation_token: token });
}
const setup = (o: WorldOpts = {}) => world(o);

const future = new Date(Date.now() + 86_400_000).toISOString();

describe("tool schemas reject cross-tenant / unknown arguments", () => {
  it("every tool refuses a model-supplied tenant id", () => {
    const { turn } = setup();
    const { validate } = turn({});
    const samples = {
      check_availability: { service_id: SERVICE, date: "2030-01-01" },
      prepare_booking: bookingArgs,
      create_booking: { ...bookingArgs, confirmation_token: "x".repeat(20) },
      prepare_reschedule: { appointment_id: APPT, date: "2030-01-01", time: "17:30" },
      reschedule_booking: { appointment_id: APPT, date: "2030-01-01", time: "17:30", confirmation_token: "x".repeat(20) },
      prepare_cancel: { appointment_id: APPT },
      cancel_booking: { appointment_id: APPT, confirmation_token: "x".repeat(20) },
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

  it("there are no list_services / list_providers tools any more (the catalog is in the prompt)", () => {
    const { tools } = setup().turn({});
    expect(Object.keys(tools).sort()).toEqual([
      "cancel_booking", "check_availability", "create_booking", "get_my_appointments", "prepare_booking", "prepare_cancel",
      "prepare_reschedule", "reschedule_booking", "search_knowledge",
    ]);
  });

  it("starts_at with an offset is no longer accepted from the model; times are date + time", () => {
    const { validate } = setup().turn({});
    const { date, time, ...rest } = bookingArgs;
    void date;
    void time;
    expect(validate("prepare_booking", { ...rest, starts_at: "2026-11-15T17:30:00+00:00" }).issues).toBeDefined();
    expect(validate("check_availability", { service_id: SERVICE, date_from: "2030-01-01" }).issues).toBeUndefined(); // old name still read as `date`
  });
});

describe("tools always use the server tenant", () => {
  it("check_availability, search_knowledge and the booking steps pass ctx.tenantId to SQL", async () => {
    const w = setup({ spec: { rpc: { match_kb_chunks: { data: [] } } } });
    const t = w.turn({});
    await t.run("check_availability", { service_id: SERVICE, date: "2030-01-01" });
    await t.run("search_knowledge", { query: "where are you" });
    await book(w);
    expect(w.rpcCalls.length).toBeGreaterThanOrEqual(5);
    for (const c of w.rpcCalls.filter((c) => c.fn !== "customer_get_appointments" && c.fn !== "check_rate_limit")) {
      expect(c.args.p_tenant_id, c.fn).toBe(TENANT);
    }
  });

  it("check_availability returns business-local date and time, never an instant the model must convert", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      slot_provider_id: PROVIDER,
      slot_start: new Date(Date.UTC(2030, 0, 1, 6 + (i % 8), 0)).toISOString(),
      slot_end: new Date(Date.UTC(2030, 0, 1, 7, 0)).toISOString(),
    }));
    const { turn } = setup({ spec: { rpc: { get_available_slots: { data: rows } } } });
    const r = await turn({}).run("check_availability", { service_id: SERVICE, date: "2030-01-01" });
    expect(r.total_found).toBe(30);
    expect(r.slots).toHaveLength(12);
    expect(r.slots[0]).toMatchObject({ provider: "Dr Ahmed", date: "2030-01-01", time: "09:00" }); // 06:00Z = 09:00 in Riyadh
    expect(r.slots[0].starts_at).toBeUndefined();
    expect(r.timezone).toBe("Asia/Riyadh");
  });

  it("check_availability with a time sorts the nearest slots first and flags an exact match", async () => {
    const { turn } = setup();
    const r = await turn({}).run("check_availability", { service_id: SERVICE, date: "2030-01-01", date_to: "2030-01-01", time: "17:30" });
    expect(r.slots[0]).toMatchObject({ date: "2030-01-01", time: "17:30" });
    expect(r.exact_match).toBe(true);
  });
});

describe("slot_taken handling", () => {
  it("maps SQLSTATE 23P01 to a retry-with-other-slots result and releases the confirmation", async () => {
    const w = setup({ spec: { rpc: { create_public_booking: { error: { code: "23P01", message: "slot_taken" } } } } });
    const r = await book(w);
    expect(r).toMatchObject({ ok: false, error: "slot_taken", retry_with_other_slots: true });
    expect(r.message).toMatch(/check_availability/);
    expect(w.used.size).toBe(0); // nothing was created, the confirmation is not burned
  });

  it("maps reschedule slot_taken the same way", async () => {
    const appt = { id: APPT, tenant_id: TENANT, status: "confirmed", starts_at: future, service_name_en: "S", provider_name_en: "P" };
    const w = setup({
      spec: {
        tables: { conversations: { customer_id: "c1" }, customers: { access_token: "tok" }, appointments: { provider_id: PROVIDER, service_id: SERVICE } },
        rpc: { customer_get_appointments: { data: [appt] }, customer_reschedule_appointment: { error: { code: "23P01", message: "slot_taken" } } },
      },
    });
    const a = { appointment_id: APPT, date: "2030-01-01", time: "17:30" };
    const p = await w.turn({ userMessageCount: 2 }).run("prepare_reschedule", a);
    expect(p.ok).toBe(true);
    const r = await w.turn({}).run("reschedule_booking", { ...a, confirmation_token: w.deliver() });
    expect(r).toMatchObject({ ok: false, error: "slot_taken", retry_with_other_slots: true });
  });

  it.each(["too_far", "too_many_bookings", "invalid_status", "forbidden"])("maps %s to a known error", async (code) => {
    const r = await book(setup({ spec: { rpc: { create_public_booking: { error: { message: code } } } } }));
    expect(r.error).toBe(code);
    expect(r.message).not.toMatch(/went wrong/);
  });

  it("does not leak unknown DB errors", async () => {
    const r = await book(setup({ spec: { rpc: { create_public_booking: { error: { message: "relation foo secret detail" } } } } }));
    expect(r.error).toBe("internal_error");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});

describe("customer-scoped tools", () => {
  it("never returns the customer token and links the conversation when a token is returned", async () => {
    const w = setup({
      spec: {
        tables: { customers: { id: "cust-1" } },
        rpc: { create_public_booking: { data: { appointment_id: APPT, status: "confirmed", starts_at: future, customer_token: "SECRET-TOKEN" } } },
      },
    });
    const r = await book(w);
    expect(JSON.stringify(r)).not.toContain("SECRET-TOKEN");
    expect(r.manageable_in_chat).toBe(true);
    expect(w.writes.some((x) => x.table === "conversations" && x.op === "update")).toBe(true);
  });

  it("does not link the conversation when no token is returned (pre-existing customer)", async () => {
    const w = setup({
      spec: { tables: { customers: { id: "cust-1" } }, rpc: { create_public_booking: { data: { appointment_id: APPT, status: "confirmed", starts_at: future, customer_token: null } } } },
    });
    const r = await book(w);
    expect(r.manageable_in_chat).toBe(false);
    expect(w.writes.some((x) => x.table === "conversations")).toBe(false);
  });

  it("cannot prepare or cancel an appointment of another tenant, even with a valid token", async () => {
    const foreign = { id: APPT, tenant_id: OTHER_TENANT, status: "confirmed", starts_at: future };
    const w = setup({
      spec: {
        tables: { conversations: { customer_id: "c1" }, customers: { access_token: "tok" } },
        rpc: { customer_get_appointments: { data: [foreign] }, customer_cancel_appointment: { data: true } },
      },
    });
    expect(await w.turn({}).run("prepare_cancel", { appointment_id: APPT })).toMatchObject({ ok: false, error: "appointment_not_found" });
    expect(w.rpcCalls.some((c) => c.fn === "customer_cancel_appointment")).toBe(false);
  });

  it("cancels an own appointment after prepare_cancel and the visitor's yes", async () => {
    const mine = { id: APPT, tenant_id: TENANT, status: "confirmed", starts_at: future, service_name_en: "S", provider_name_en: "P", service_name_ar: "خ", provider_name_ar: "م" };
    const w = setup({
      spec: { tables: { conversations: { customer_id: "c1" }, customers: { access_token: "tok" } }, rpc: { customer_get_appointments: { data: [mine] }, customer_cancel_appointment: { data: true } } },
    });
    const p = await w.turn({ userMessageCount: 2 }).run("prepare_cancel", { appointment_id: APPT });
    expect(p.ok).toBe(true);
    expect(p.summary_text).toMatch(/Cancel this appointment/);
    expect(w.rpcCalls.some((c) => c.fn === "customer_cancel_appointment")).toBe(false); // prepare changes nothing
    expect(await w.turn({}).run("cancel_booking", { appointment_id: APPT, confirmation_token: w.deliver() })).toEqual({ ok: true, cancelled: true });
    expect(w.rpcCalls.find((c) => c.fn === "customer_cancel_appointment")?.args).toMatchObject({ p_token: "tok" });
  });

  it("get_my_appointments is empty when no customer is linked", async () => {
    const r = await setup({ spec: { tables: { conversations: { customer_id: null } } } }).turn({}).run("get_my_appointments", {});
    expect(r.appointments).toEqual([]);
  });
});

describe("transient database errors", () => {
  it.each(["40P01", "40001"])("maps SQLSTATE %s to a friendly try-again result, not internal_error", async (code) => {
    const r = await book(setup({ spec: { rpc: { create_public_booking: { error: { code, message: "deadlock detected" } } } } }));
    expect(r).toMatchObject({ ok: false, error: "try_again", retry_same_request: true });
    expect(r.message).toMatch(/try the same call once more/);
    expect(JSON.stringify(r)).not.toContain("deadlock");
  });
  it("still maps 23P01 to slot_taken", async () => {
    expect((await book(setup({ spec: { rpc: { create_public_booking: { error: { code: "23P01", message: "conflicting key" } } } } }))).error).toBe("slot_taken");
  });
});

describe("a deposit tenant", () => {
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
  const tenantTbl = (over: Record<string, unknown> = {}) => ({ ...fullTenantRow, slug: "al-noor", deposit_enabled: true, deposit_type: "fixed", deposit_value: 50, ...over });
  const env = (kv: Record<string, string>) => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://dawrak.example/");
    for (const [k, v] of Object.entries(kv)) vi.stubEnv(k, v);
  };
  afterEach(() => vi.unstubAllEnvs());

  it("the summary shows the deposit; creates the payment row and returns an absolute pay link with only the pay token", async () => {
    env({ PAYMENT_PROVIDER: "moyasar", MOYASAR_SECRET_KEY: "sk_test_x" });
    const w = setup({ spec: { tables: { tenants: tenantTbl(), customers: { id: "cust-1" } }, rpc: { create_public_booking: { data: held } } } });
    const p = await w.prepared();
    expect(p.r.summary_text).toMatch(/Deposit: 50 SAR/);
    expect(p.r.summary_text).toMatch(/held for 15 minutes/);
    const r = await w.turn({}).run("create_booking", { ...bookingArgs, confirmation_token: p.token });
    expect(r.ok).toBe(true);
    const pay = w.writes.find((x) => x.table === "payments" && x.op === "insert");
    expect(pay?.payload).toMatchObject({ tenant_id: TENANT, appointment_id: APPT, amount: 50, currency: "SAR", status: "pending", provider: "moyasar" });
    const token = (pay!.payload as { public_token: string }).public_token;
    expect(r.pay_url).toBe(`https://dawrak.example/en/c/al-noor/pay/${token}`);
    expect(r.hold_minutes).toBe(15);
    expect(JSON.stringify(r)).not.toContain("cust-secret-token");
  });

  it("creates no payment for a confirmed (non-deposit) booking", async () => {
    env({ PAYMENT_PROVIDER: "moyasar", MOYASAR_SECRET_KEY: "sk_test_x" });
    const w = setup({ spec: { rpc: { create_public_booking: { data: { ...held, status: "confirmed" } } } } });
    const r = await book(w);
    expect(r.pay_url).toBeUndefined();
    expect(w.writes.some((x) => x.table === "payments")).toBe(false);
  });

  it("a non-demo tenant never gets the fake provider: prepare refuses BEFORE asking for confirmation, nothing is booked", async () => {
    env({ PAYMENT_PROVIDER: "fake" });
    const w = setup({ spec: { tables: { tenants: tenantTbl() }, rpc: { create_public_booking: { data: held } } } });
    const r = await w.turn({ userMessageCount: 2 }).run("prepare_booking", bookingArgs);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("payments_unavailable");
    expect(r.message).toMatch(/NO appointment was created/);
    expect(r.message).toMatch(/NO booking was made/);
    expect(r.confirmation_token).toBeUndefined();
    expect(w.rpcCalls.some((c) => c.fn === "create_public_booking")).toBe(false);
  });

  it("if payments become unavailable after the summary, execution still refuses and does not consume the phone limit", async () => {
    env({ PAYMENT_PROVIDER: "moyasar", MOYASAR_SECRET_KEY: "sk_test_x" });
    const w = setup({ spec: { tables: { tenants: tenantTbl() }, rpc: { create_public_booking: { data: held } } } });
    const p = await w.prepared();
    expect(p.r.ok).toBe(true);
    vi.stubEnv("PAYMENT_PROVIDER", "fake");
    vi.stubEnv("MOYASAR_SECRET_KEY", "");
    const r = await w.turn({}).run("create_booking", { ...bookingArgs, confirmation_token: p.token });
    expect(r.error).toBe("payments_unavailable");
    expect(w.rpcCalls.some((c) => c.fn === "create_public_booking")).toBe(false);
    expect(w.rpcCalls.some((c) => c.fn === "check_rate_limit")).toBe(false);
  });

  it("a demo tenant may use the fake provider", async () => {
    env({ PAYMENT_PROVIDER: "fake" });
    const w = setup({ spec: { tables: { tenants: tenantTbl({ is_demo: true }) }, rpc: { create_public_booking: { data: held } } } });
    const r = await book(w);
    expect(w.writes.find((x) => x.table === "payments")?.payload).toMatchObject({ provider: "fake" });
    expect(r.pay_url).toMatch(/^https:\/\/dawrak\.example\/en\/c\/al-noor\/pay\/[A-Za-z0-9_-]{48}$/);
  });
});

describe("create_booking per-phone daily limit (L4)", () => {
  it("checks a hashed per-tenant/phone bucket (3 per day) BEFORE creating the booking", async () => {
    const odd = "+966 50-000 (0000)";
    const w = setup({});
    await book(w, { ...bookingArgs, phone: odd }, { texts: [`Sara Ali ${odd}`] });
    const limit = w.rpcCalls.findIndex((c) => c.fn === "check_rate_limit");
    const create = w.rpcCalls.findIndex((c) => c.fn === "create_public_booking");
    expect(limit).toBeGreaterThanOrEqual(0);
    expect(limit).toBeLessThan(create);
    expect(w.rpcCalls[limit].args).toMatchObject({ p_max: 3, p_window: "1 day" });
    const key = String(w.rpcCalls[limit].args.p_key);
    expect(key).toMatch(new RegExp(`^book-phone:${TENANT}:[0-9a-f]{64}$`));
    expect(key).not.toContain("966");
    const again = setup({});
    await book(again, { ...bookingArgs, phone: PHONE });
    expect(again.rpcCalls.find((c) => c.fn === "check_rate_limit")!.args.p_key).toBe(key);
  });

  it("over the limit: refuses with a clear tool error and never creates anything", async () => {
    const w = setup({ spec: { rpc: { check_rate_limit: { data: false } } } });
    const r = await book(w);
    expect(r).toMatchObject({ ok: false, error: "phone_booking_limit" });
    expect(w.rpcCalls.some((c) => c.fn === "create_public_booking")).toBe(false);
  });
});

