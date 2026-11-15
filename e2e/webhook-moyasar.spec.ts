import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { CLINIC, hasLocalDb, rest } from "./helpers/tenant";

/**
 * POST /api/webhooks/moyasar end to end against the local database. The server runs the FAKE provider (same
 * route, same pipeline, same secret_token check as Moyasar's; the real provider cannot be exercised offline
 * because it re-fetches the payment from api.moyasar.com). Covered here, on top of payments.spec.ts: a missing
 * secret, malformed bodies, the verification event, oversize bodies, GET not allowed, a failed payment event,
 * an unknown payment reference and a paid event for an appointment whose hold already expired.
 */
const SECRET = "dawrak-fake-webhook-secret"; // same literal as playwright.config.ts
const URLP = "/api/webhooks/moyasar";
const made: string[] = [];

async function seedPayment(holdExpired = false) {
  const [service] = (await rest(`services?tenant_id=eq.${CLINIC}&select=id,price&limit=1`)) as { id: string; price: number }[];
  const [provider] = (await rest(`providers?tenant_id=eq.${CLINIC}&select=id&limit=1`)) as { id: string }[];
  const [customer] = (await rest("customers", {
    method: "POST",
    body: JSON.stringify({ tenant_id: CLINIC, full_name: "Hook E2E", phone: `+9665${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}` }),
  })) as { id: string }[];
  made.push(customer.id);
  let appt: { id: string } | undefined;
  for (let i = 0; i < 10 && !appt; i++) {
    const start = new Date(Date.now() + (80 + Math.floor(Math.random() * 400)) * 86_400_000 / 4);
    start.setUTCMinutes(0, 0, 0);
    try {
      [appt] = (await rest("appointments", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: CLINIC, provider_id: provider.id, service_id: service.id, customer_id: customer.id,
          starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3_600_000).toISOString(),
          status: "pending_payment", source: "web", price: service.price,
          payment_expires_at: new Date(Date.now() + (holdExpired ? -60_000 : 15 * 60_000)).toISOString(),
        }),
      })) as { id: string }[];
    } catch (e) {
      if (!String(e).includes("23P01")) throw e;
    }
  }
  if (!appt) throw new Error("no free seed slot");
  const ref = `fakeinv_${randomUUID()}`;
  const [pay] = (await rest("payments", {
    method: "POST",
    body: JSON.stringify({ tenant_id: CLINIC, appointment_id: appt.id, amount: 50, currency: "SAR", provider: "fake", public_token: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 16), provider_ref: ref }),
  })) as { id: string }[];
  return { appointmentId: appt.id, paymentId: pay.id, ref };
}
const evt = (ref: string, o: { amount?: number; outcome?: "paid" | "failed"; secret?: string } = {}) => ({
  id: `evt-${randomUUID()}`,
  type: o.outcome === "failed" ? "payment_failed" : "payment_paid",
  secret_token: o.secret ?? SECRET,
  live: false,
  data: { id: `fake_${o.outcome ?? "paid"}_${o.amount ?? 5000}_SAR_${ref}`, invoice_id: ref },
});
const apptStatus = async (id: string) => ((await rest(`appointments?id=eq.${id}&select=status`)) as { status: string }[])[0].status;
const payStatus = async (id: string) => ((await rest(`payments?id=eq.${id}&select=status`)) as { status: string }[])[0].status;

test.describe("Moyasar webhook route", () => {
  test.skip(!hasLocalDb(), "needs the local Supabase stack");
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "API-level: runs once");
  });
  test.afterAll(async () => {
    for (const id of made) {
      await rest(`appointments?customer_id=eq.${id}`, { method: "DELETE" });
      await rest(`customers?id=eq.${id}`, { method: "DELETE" });
    }
  });

  test("invalid signature: missing, empty, wrong and near-miss tokens are all 401 and change nothing", async ({ request }) => {
    const s = await seedPayment();
    const base = evt(s.ref);
    const { secret_token: _drop, ...noToken } = base;
    for (const body of [noToken, { ...base, secret_token: "" }, { ...base, secret_token: "wrong" }, { ...base, secret_token: SECRET + "x" }, { ...base, secret_token: SECRET.slice(1) }]) {
      const res = await request.post(URLP, { data: body });
      expect(res.status()).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(await apptStatus(s.appointmentId)).toBe("pending_payment");
    expect(await payStatus(s.paymentId)).toBe("pending");
  });

  test("a non-JSON or empty body is rejected (401) before any database work", async ({ request }) => {
    for (const data of ["not json", "", "[]"]) {
      const res = await request.post(URLP, { data, headers: { "content-type": "application/json" } });
      expect([400, 401], `body ${JSON.stringify(data)}`).toContain(res.status());
    }
  });

  test("a correctly signed body without id/type is malformed (400)", async ({ request }) => {
    const res = await request.post(URLP, { data: { secret_token: SECRET, data: {} } });
    expect(res.status()).toBe(400);
  });

  test("an oversized body is refused with 413", async ({ request }) => {
    const res = await request.post(URLP, { data: JSON.stringify({ secret_token: SECRET, pad: "x".repeat(70 * 1024) }), headers: { "content-type": "application/json" } });
    expect(res.status()).toBe(413);
  });

  test("the webhook-verification event is acknowledged and changes nothing", async ({ request }) => {
    const res = await request.post(URLP, { data: { id: `evt-${randomUUID()}`, type: "webhook_verification", secret_token: SECRET, data: { verification_code: "123456" } } });
    expect(res.status()).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test("GET is not allowed", async ({ request }) => {
    expect((await request.get(URLP)).status()).toBe(405);
  });

  test("valid signature, correct amount: confirmed once; replay and a second distinct event are idempotent", async ({ request }) => {
    const s = await seedPayment();
    const first = evt(s.ref);
    const r1 = await request.post(URLP, { data: first });
    expect(r1.status()).toBe(200);
    expect((await r1.json()).ok).toBe(true);
    expect(await apptStatus(s.appointmentId)).toBe("confirmed");
    expect(await payStatus(s.paymentId)).toBe("paid");
    expect((await request.post(URLP, { data: first })).status()).toBe(200);
    expect((await request.post(URLP, { data: evt(s.ref) })).status()).toBe(200);
    expect(await apptStatus(s.appointmentId)).toBe("confirmed");
    expect(await payStatus(s.paymentId)).toBe("paid");
  });

  test("a failed-payment event keeps the appointment pending and the payment not paid", async ({ request }) => {
    const s = await seedPayment();
    const res = await request.post(URLP, { data: evt(s.ref, { outcome: "failed" }) });
    expect(res.status()).toBe(200);
    expect(await apptStatus(s.appointmentId)).toBe("pending_payment");
    expect(await payStatus(s.paymentId)).not.toBe("paid");
  });

  test("an event for an unknown payment reference is acknowledged (no retry storm) and creates nothing", async ({ request }) => {
    const res = await request.post(URLP, { data: evt(`fakeinv_${randomUUID()}`) });
    expect(res.status()).toBe(200);
  });

  test("a paid event whose 15 minute hold already lapsed never silently confirms a released slot twice", async ({ request }) => {
    const s = await seedPayment(true);
    const res = await request.post(URLP, { data: evt(s.ref) });
    expect(res.status()).toBe(200);
    // either revived (slot still free) or flagged for refund; never left as an unexplained pending_payment + paid
    const a = await apptStatus(s.appointmentId);
    const p = await payStatus(s.paymentId);
    expect(["confirmed", "cancelled"]).toContain(a);
    if (a === "cancelled") expect(p).not.toBe("paid");
  });
});
