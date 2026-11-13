import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server actions with a fake session and a fake Supabase client: checks that the role gate and
 * validation run BEFORE any database call, which columns are written, and how DB errors surface.
 */
type Result = { data: unknown; error: { code?: string; message?: string } | null };
const state = vi.hoisted(() => ({
  session: null as unknown,
  results: {} as Record<string, Result>,
  calls: [] as { table: string; op: string; args: unknown[] }[],
}));

vi.mock("@/lib/auth/session", () => ({ getSession: async () => state.session }));
vi.mock("@/lib/auth/supabase", () => ({
  createSupabaseServerClient: async () => ({
    from(table: string) {
      let op = "select";
      let fixed = false;
      const b: object = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (res: (r: Result) => void) =>
                res(state.results[`${table}.${op}`] ?? { data: [], error: null });
            }
            return (...args: unknown[]) => {
              if (["select", "insert", "update", "delete"].includes(prop)) {
                if (!fixed) {
                  op = prop;
                  fixed = true;
                  state.calls.push({ table, op, args });
                }
              }
              return b;
            };
          },
        },
      );
      return b;
    },
  }),
}));

import { saveProvider, saveWorkingHours, addTimeOff } from "@/app/[locale]/dashboard/providers/actions";
import { saveService } from "@/app/[locale]/dashboard/services/actions";
import { saveSettings } from "@/app/[locale]/dashboard/settings/actions";

const TENANT = "d0000000-0000-4000-8000-000000000001";
const PROVIDER = "f1000000-0000-4000-8000-000000000001";
const session = (role: string, over: object = {}) => ({
  userId: "u1",
  tenant: { id: TENANT, timezone: "Asia/Riyadh", currency: "SAR", is_demo: false, kind: "clinic", name_ar: "ع", name_en: "C" },
  role,
  providerId: null,
  ...over,
});

const service = {
  name_ar: "كشف",
  name_en: "Check-up",
  description_ar: "",
  description_en: "",
  duration_min: "30",
  buffer_min: "10",
  price: "150",
  is_active: true,
  provider_ids: [],
};
const settings = {
  name_ar: "ع",
  name_en: "Clinic",
  timezone: "Asia/Riyadh",
  currency: "SAR",
  deposit_enabled: false,
  deposit_type: "fixed",
  deposit_value: "0",
  logo_url: "",
  brand_color: "",
};

beforeEach(() => {
  state.session = session("owner");
  state.results = {};
  state.calls = [];
});

describe("role gate runs before any database access", () => {
  it.each(["receptionist", "provider"])("%s cannot create services, providers, hours, time off or settings", async (role) => {
    state.session = session(role, { providerId: PROVIDER });
    const results = await Promise.all([
      saveService(service),
      saveProvider({ name_ar: "د", name_en: "Dr", is_active: true }),
      saveWorkingHours({ providerId: PROVIDER, days: [] }),
      addTimeOff({ providerId: PROVIDER, start: "2026-12-01T09:00", end: "2026-12-01T17:00" }),
      saveSettings(settings),
    ]);
    for (const r of results) expect(r).toMatchObject({ ok: false, code: "forbidden" });
    expect(state.calls).toHaveLength(0);
  });

  it("signed-out users are forbidden", async () => {
    state.session = null;
    expect(await saveService(service)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await saveSettings(settings)).toMatchObject({ ok: false, code: "forbidden" });
    expect(state.calls).toHaveLength(0);
  });
});

describe("validation", () => {
  it("rejects bad input without touching the database and names the fields", async () => {
    const r = await saveService({ ...service, price: "-5", name_en: "" });
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect((r as { fields: string[] }).fields.sort()).toEqual(["name_en", "price"]);
    expect(state.calls).toHaveLength(0);
  });

  it("rejects inverted and overlapping hours with the weekday, before any write", async () => {
    const inverted = await saveWorkingHours({
      providerId: PROVIDER,
      days: [{ weekday: 2, ranges: [{ start: "17:00", end: "09:00" }] }],
    });
    expect(inverted).toMatchObject({ ok: false, code: "hours_inverted", weekday: 2 });
    const overlap = await saveWorkingHours({
      providerId: PROVIDER,
      days: [{ weekday: 5, ranges: [{ start: "09:00", end: "13:00" }, { start: "12:00", end: "15:00" }] }],
    });
    expect(overlap).toMatchObject({ ok: false, code: "hours_overlap", weekday: 5 });
    expect(state.calls).toHaveLength(0);
  });

  it("rejects an inverted time-off range", async () => {
    const r = await addTimeOff({ providerId: PROVIDER, start: "2026-12-02T09:00", end: "2026-12-01T09:00" });
    expect(r).toMatchObject({ ok: false, code: "timeoff_invalid" });
    expect(state.calls).toHaveLength(0);
  });

  it("rejects a service linked to a provider of another tenant", async () => {
    state.results["providers.select"] = { data: [], error: null };
    const r = await saveService({ ...service, provider_ids: [PROVIDER] });
    expect(r).toMatchObject({ ok: false, code: "invalid", fields: ["provider_ids"] });
    expect(state.calls.some((c) => c.op === "insert" || c.op === "update")).toBe(false);
  });
});

describe("writes", () => {
  it("sends only the granted tenant columns, never id, slug, kind or is_demo", async () => {
    state.results["tenants.update"] = { data: [{ id: TENANT }], error: null };
    const r = await saveSettings({ ...settings, brand_color: "#0F766E", is_demo: false, slug: "x", kind: "salon" });
    expect(r).toEqual({ ok: true });
    const upd = state.calls.find((c) => c.table === "tenants" && c.op === "update")!;
    expect(Object.keys(upd.args[0] as object).sort()).toEqual(
      [
        "brand_color",
        "currency",
        "deposit_enabled",
        "deposit_type",
        "deposit_value",
        "logo_url",
        "name_ar",
        "name_en",
        "timezone",
      ].sort(),
    );
    expect((upd.args[0] as { brand_color: string }).brand_color).toBe("#0f766e");
  });

  it("demo tenant: refuses a changed locked field before any update, and sends only deposit_* otherwise", async () => {
    state.session = session("owner", { tenant: { ...(session("owner") as { tenant: object }).tenant, is_demo: true } });
    const current = { name_ar: "ع", name_en: "Clinic", timezone: "Asia/Riyadh", currency: "SAR", logo_url: null, brand_color: null };
    state.results["tenants.select"] = { data: current, error: null };
    state.results["tenants.update"] = { data: [{ id: TENANT }], error: null };

    const renamed = await saveSettings({ ...settings, name_en: "Hacked", brand_color: "#be185d" });
    expect(renamed).toMatchObject({ ok: false, code: "demo_readonly" });
    expect((renamed as { fields: string[] }).fields.sort()).toEqual(["brand_color", "name_en"]);
    expect(state.calls.some((c) => c.op === "update")).toBe(false);

    state.calls.length = 0;
    const ok = await saveSettings({ ...settings, name_en: "Clinic", deposit_enabled: true, deposit_type: "fixed", deposit_value: "25" });
    expect(ok).toEqual({ ok: true });
    const upd = state.calls.find((c) => c.table === "tenants" && c.op === "update")!;
    expect(Object.keys(upd.args[0] as object).sort()).toEqual(["deposit_enabled", "deposit_type", "deposit_value"]);
  });

  it("treats an RLS-denied update (zero rows) as forbidden", async () => {
    state.results["tenants.update"] = { data: [], error: null };
    expect(await saveSettings(settings)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("inserts a service with the tenant from the session, not from the input", async () => {
    state.results["services.insert"] = { data: { id: "11111111-1111-4111-8111-111111111111" }, error: null };
    const r = await saveService({ ...service, tenant_id: "other" });
    expect(r).toMatchObject({ ok: true, id: "11111111-1111-4111-8111-111111111111" });
    const ins = state.calls.find((c) => c.table === "services" && c.op === "insert")!;
    expect(ins.args[0]).toMatchObject({ tenant_id: TENANT, duration_min: 30, price: 150 });
  });
});

describe("database errors become friendly codes", () => {
  it("demo_readonly (42501) is not reported as a plain permission error", async () => {
    state.results["tenants.update"] = { data: null, error: { code: "42501", message: "demo_readonly" } };
    expect(await saveSettings(settings)).toMatchObject({ ok: false, code: "demo_readonly" });
  });

  it("demo_limit (54000)", async () => {
    state.results["providers.insert"] = { data: null, error: { code: "54000", message: "demo_limit" } };
    expect(await saveProvider({ name_ar: "د", name_en: "Dr", is_active: true })).toMatchObject({
      ok: false,
      code: "demo_limit",
    });
  });

  it("RLS denial and constraint violations", async () => {
    state.results["services.insert"] = {
      data: null,
      error: { code: "42501", message: "new row violates row-level security policy" },
    };
    expect(await saveService(service)).toMatchObject({ ok: false, code: "forbidden" });
    state.results["services.insert"] = { data: null, error: { code: "23514", message: "check" } };
    expect(await saveService(service)).toMatchObject({ ok: false, code: "too_long" });
    state.results["services.insert"] = { data: null, error: { code: "23503", message: "fk" } };
    expect(await saveService(service)).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("hours write order", () => {
  it("inserts the new rows before deleting the old ones", async () => {
    state.results["providers.select"] = { data: { id: PROVIDER }, error: null };
    state.results["working_hours.select"] = { data: [{ id: "old1" }], error: null };
    state.results["working_hours.insert"] = { data: [{ id: "new1" }], error: null };
    const r = await saveWorkingHours({
      providerId: PROVIDER,
      days: [{ weekday: 1, ranges: [{ start: "10:00", end: "12:00" }] }],
    });
    expect(r).toEqual({ ok: true, rows: 1 });
    const ops = state.calls.filter((c) => c.table === "working_hours").map((c) => c.op);
    expect(ops.indexOf("insert")).toBeLessThan(ops.indexOf("delete"));
  });
});
