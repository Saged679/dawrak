import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
const tenantBySlug = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/client", () => ({ getServiceClient: () => ({ rpc }) }));
vi.mock("@/lib/db/public", () => ({
  getTenantBySlug: (...a: unknown[]) => tenantBySlug(...a),
  getSlots: vi.fn(),
}));

import { loadPortal } from "@/lib/customer/portal";
import { CANCEL_WINDOW_HOURS, canChange, isCustomerToken, withinChangeWindow } from "@/lib/customer/policy";

const TOKEN = "a1".repeat(24);
const TENANT = { id: "t1", slug: "clinic-a", name_ar: "ع", name_en: "A", timezone: "Asia/Riyadh", is_demo: false };
const CUSTOMER = { customer_id: "c1", tenant_id: "t1", tenant_slug: "clinic-a", full_name: "Sara", locale: "en" };

function stub(over: { customer?: unknown[]; appts?: unknown[] } = {}) {
  rpc.mockImplementation(async (name: string) => {
    if (name === "customer_portal_get") return { data: over.customer ?? [CUSTOMER], error: null };
    if (name === "customer_portal_appointments") return { data: over.appts ?? [], error: null };
    throw new Error(`unexpected rpc ${name}`);
  });
}

describe("loadPortal (token lookup)", () => {
  beforeEach(() => {
    rpc.mockReset();
    tenantBySlug.mockReset();
    tenantBySlug.mockResolvedValue(TENANT);
  });

  it("returns the customer's appointments for a valid token under the right clinic", async () => {
    stub({
      appts: [
        {
          id: "ap1", provider_id: "p", service_id: "s", provider_name_ar: "م", provider_name_en: "P",
          service_name_ar: "خ", service_name_en: "S", starts_at: "2030-01-01T10:00:00Z", ends_at: "2030-01-01T10:30:00Z",
          status: "confirmed", price: "100.00", currency: "SAR", deposit_status: "paid", deposit_amount: "50.00", payment_expires_at: null,
        },
      ],
    });
    const p = await loadPortal("clinic-a", TOKEN);
    expect(p?.fullName).toBe("Sara");
    expect(p?.appointments[0]).toMatchObject({ id: "ap1", price: 100, depositStatus: "paid", depositAmount: 50 });
    // the token travels only as an RPC argument, never inside the result
    expect(JSON.stringify(p)).not.toContain(TOKEN);
  });

  it("is null for a token that belongs to another clinic than the slug in the URL", async () => {
    stub({ customer: [{ ...CUSTOMER, tenant_slug: "clinic-b" }] });
    expect(await loadPortal("clinic-a", TOKEN)).toBeNull();
    expect(rpc).not.toHaveBeenCalledWith("customer_portal_appointments", expect.anything());
  });

  it("is null when the database finds nothing (unknown or expired token)", async () => {
    stub({ customer: [] });
    expect(await loadPortal("clinic-a", TOKEN)).toBeNull();
  });

  it("is null when the slug resolves to a different tenant id than the customer's", async () => {
    stub();
    tenantBySlug.mockResolvedValue({ ...TENANT, id: "other" });
    expect(await loadPortal("clinic-a", TOKEN)).toBeNull();
  });

  it("rejects malformed tokens and slugs without touching the database", async () => {
    stub();
    for (const t of ["", "short", "A1".repeat(24), "g".repeat(48), `${TOKEN}0`, TOKEN.slice(1), "../etc/passwd", "a".repeat(200)]) {
      expect(await loadPortal("clinic-a", t), t).toBeNull();
    }
    expect(await loadPortal("Bad Slug", TOKEN)).toBeNull();
    expect(await loadPortal("x".repeat(80), TOKEN)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("change window policy", () => {
  const now = new Date("2030-01-01T10:00:00Z");
  it("allows changes until CANCEL_WINDOW_HOURS before the start", () => {
    expect(CANCEL_WINDOW_HOURS).toBe(2);
    expect(withinChangeWindow("2030-01-01T12:00:01Z", now)).toBe(true);
    expect(withinChangeWindow("2030-01-01T12:00:00Z", now)).toBe(true);
    expect(withinChangeWindow("2030-01-01T11:59:59Z", now)).toBe(false);
    expect(withinChangeWindow("2029-12-31T10:00:00Z", now)).toBe(false);
  });
  it("only pending_payment and confirmed appointments are changeable", () => {
    for (const s of ["cancelled", "completed", "no_show"]) expect(canChange(s, "2030-02-01T10:00:00Z", now)).toBe(false);
    for (const s of ["pending_payment", "confirmed"]) expect(canChange(s, "2030-02-01T10:00:00Z", now)).toBe(true);
  });
  it("token shape is 48 lowercase hex chars", () => {
    expect(isCustomerToken(TOKEN)).toBe(true);
    expect(isCustomerToken(TOKEN.toUpperCase())).toBe(false);
    expect(isCustomerToken(undefined)).toBe(false);
  });
});
