import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createDepositTenant, type DepositTenant } from "./helpers/tenant";

/**
 * Deposit payment e2e with the FAKE provider (no network, no Moyasar keys). The server must run with
 * PAYMENT_PROVIDER=fake, ALLOW_FAKE_PAYMENTS=true and FAKE_WEBHOOK_SECRET (playwright.config.ts sets them).
 */
function env(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    return readFileSync(".env.local", "utf8").match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
  } catch {
    return undefined;
  }
}
const SUPABASE_URL = env("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const FAKE_SECRET = "dawrak-fake-webhook-secret";

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rest ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const created: string[] = []; // customer ids to clean up
let dayOffset = 25 + Math.floor(Math.random() * 30);

let biz: DepositTenant;

/** A pending_payment appointment + pending fake payment, created straight in the database (non-demo deposit clinic). */
async function seedHeldPayment() {
  const tenant = { id: biz.tenantId };
  const slug = biz.slug;
  const service = { id: biz.serviceId, price: biz.price };
  const provider = { id: biz.providerId };
  const [customer] = await rest("customers", {
    method: "POST",
    body: JSON.stringify({ tenant_id: tenant.id, full_name: "Pay E2E", phone: `0555${Math.floor(Math.random() * 1e6)}` }),
  });
  created.push(customer.id);
  const start = new Date(Date.now() + dayOffset++ * 86_400_000);
  start.setUTCHours(3, 0, 0, 0);
  const [appt] = await rest("appointments", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: tenant.id,
      provider_id: provider.id,
      service_id: service.id,
      customer_id: customer.id,
      starts_at: start.toISOString(),
      ends_at: new Date(start.getTime() + 3_600_000).toISOString(),
      status: "pending_payment",
      source: "web",
      price: service.price,
      payment_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    }),
  });
  const token = randomBytes(36).toString("base64url");
  const [payment] = await rest("payments", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: tenant.id,
      appointment_id: appt.id,
      amount: 50,
      currency: "SAR",
      provider: "fake",
      public_token: token,
    }),
  });
  return { token, slug, appointmentId: appt.id as string, paymentId: payment.id as string };
}

const apptStatus = async (id: string) => (await rest(`appointments?id=eq.${id}&select=status`))[0].status as string;
const payStatus = async (id: string) => (await rest(`payments?id=eq.${id}&select=status`))[0].status as string;
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("deposit payment (fake provider)", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!SUPABASE_URL || !SERVICE_KEY, "needs the local Supabase stack");
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "runs once; viewports are set explicitly");
  });
  test.beforeAll(async () => {
    await rest("rate_limits?key=like.ip:*", { method: "DELETE" });
    biz = await createDepositTenant();
  });
  test.afterAll(async () => {
    await biz?.cleanup();
    for (const id of created) {
      await rest(`appointments?customer_id=eq.${id}`, { method: "DELETE" });
      await rest(`customers?id=eq.${id}`, { method: "DELETE" });
    }
  });

  test("books through the UI, lands on an unguessable pay URL, pays (fake success) and the appointment is confirmed", async ({ page }) => {
    const phone = `05${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
    await page.goto(`/en/c/${biz.slug}`);
    await page.getByText(biz.serviceName, { exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText("Dr. Deposit", { exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    const slot = page.locator('input[name="slot-choice"]').nth(2);
    await slot.waitFor({ state: "attached" });
    await slot.check({ force: true });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Full name").fill("Pay Flow Tester");
    await page.getByLabel("Mobile number").fill(phone);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await page.waitForURL(new RegExp(`/en/c/${biz.slug}/pay/[A-Za-z0-9_-]{48}$`));
    const token = page.url().split("/pay/")[1];
    const e164 = `+966${phone.slice(1)}`;
    const [cust] = await rest(`customers?phone=eq.${encodeURIComponent(e164)}&select=id`);
    created.push(cust.id);
    expect(page.url()).not.toContain(cust.id);

    await expect(page.getByTestId("pay-amount")).toContainText("SAR");
    await expect(page.getByTestId("hold-countdown")).toContainText(/1[0-5]:\d\d/);
    const [pay] = await rest(`payments?public_token=eq.${token}&select=id,status,appointment_id,amount`);
    expect(pay.status).toBe("pending");
    expect(await apptStatus(pay.appointment_id)).toBe("pending_payment");

    await page.getByTestId("pay-button").click();
    await page.waitForURL(/\/pay\/[^/]+\/fake$/);
    await page.getByTestId("fake-succeed").click();
    await page.waitForURL(/\/result$/);
    await expect(page.getByTestId("pay-status")).toHaveAttribute("data-state", "paid");
    await expect(page.getByRole("heading", { name: /Your booking is confirmed|Deposit received/ })).toBeVisible();
    expect(await payStatus(pay.id)).toBe("paid");
    expect(await apptStatus(pay.appointment_id)).toBe("confirmed");

    // returning to the pay page after paying shows the result, not a second payment form
    await page.goto(`/en/c/${biz.slug}/pay/${token}`);
    await expect(page.getByTestId("pay-button")).toHaveCount(0);
  });

  test("fake failure keeps the appointment pending, allows a retry, then the hold expires and the slot is released", async ({ page }) => {
    const s = await seedHeldPayment();
    await page.goto(`/en/c/${s.slug}/pay/${s.token}`);
    await page.getByTestId("pay-button").click();
    await page.getByTestId("fake-fail").click();
    await page.waitForURL(/\/result$/);
    await expect(page.getByTestId("pay-status")).toHaveAttribute("data-state", "failed");
    expect(await payStatus(s.paymentId)).toBe("failed");
    expect(await apptStatus(s.appointmentId)).toBe("pending_payment");

    // retry is offered while the hold lives
    await page.goto(`/en/c/${s.slug}/pay/${s.token}`);
    await expect(page.getByTestId("pay-failed")).toBeVisible();
    await expect(page.getByTestId("pay-button")).toBeVisible();

    // time runs out: the page says so even before the cron, then the job releases the slot
    await rest(`appointments?id=eq.${s.appointmentId}`, {
      method: "PATCH",
      body: JSON.stringify({ payment_expires_at: new Date(Date.now() - 60_000).toISOString() }),
    });
    await page.reload();
    await expect(page.getByTestId("pay-status")).toHaveAttribute("data-state", "expired");
    await expect(page.getByTestId("pay-button")).toHaveCount(0);
    await rest("rpc/expire_pending_bookings", { method: "POST", body: "{}" });
    expect(await apptStatus(s.appointmentId)).toBe("cancelled");
  });

  test("invalid, guessed or cross-tenant payment URLs are 404", async ({ page }) => {
    const s = await seedHeldPayment();
    const guessed = randomBytes(36).toString("base64url");
    for (const path of [
      `/en/c/${biz.slug}/pay/${guessed}`,
      `/en/c/${biz.slug}/pay/${guessed}/result`,
      `/en/c/${biz.slug}/pay/${guessed}/fake`,
      `/en/c/${biz.slug}/pay/${s.paymentId}`, // the row id is not a credential
      `/en/c/${biz.slug}/pay/${s.appointmentId}`,
      `/en/c/${biz.slug}/pay/1`,
      `/en/c/demo-salon/pay/${s.token}`, // valid token under another clinic's path
      `/en/c/demo-salon/pay/${s.token}/result`,
      `/en/c/demo-salon/pay/${s.token}/fake`,
    ]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
    }
    expect((await page.goto(`/en/c/${biz.slug}/pay/${s.token}`))?.status()).toBe(200);
  });

  test("the result page ignores query parameters (a forged ?status=paid changes nothing)", async ({ page }) => {
    const s = await seedHeldPayment();
    await page.goto(`/en/c/${s.slug}/pay/${s.token}/result?status=paid&id=x&message=APPROVED`);
    await expect(page.getByTestId("pay-status")).toHaveAttribute("data-state", "awaiting");
    expect(await apptStatus(s.appointmentId)).toBe("pending_payment");
  });

  test("webhook: wrong secret is 401; a valid replayed event confirms exactly once", async ({ request, page }) => {
    const s = await seedHeldPayment();
    // create the checkout (sets provider_ref) through the real button
    await page.goto(`/en/c/${s.slug}/pay/${s.token}`);
    await page.getByTestId("pay-button").click();
    await page.waitForURL(/\/fake$/);
    const [row] = await rest(`payments?id=eq.${s.paymentId}&select=provider_ref,amount`);

    const body = (secret: string) => ({
      id: `evt-${randomUUID()}`,
      type: "payment_paid",
      secret_token: secret,
      live: false,
      data: { id: `fake_paid_5000_SAR_${row.provider_ref}`, invoice_id: row.provider_ref, amount: 1, status: "paid" },
    });
    const bad = await request.post("/api/webhooks/moyasar", { data: body("wrong") });
    expect(bad.status()).toBe(401);
    expect(await apptStatus(s.appointmentId)).toBe("pending_payment");

    const evt = body(FAKE_SECRET);
    expect((await request.post("/api/webhooks/moyasar", { data: evt })).status()).toBe(200);
    expect((await request.post("/api/webhooks/moyasar", { data: evt })).status()).toBe(200); // replay
    expect(await apptStatus(s.appointmentId)).toBe("confirmed");
    expect(await payStatus(s.paymentId)).toBe("paid");
    const events = await rest(`payment_events?payment_id=eq.${s.paymentId}&select=event_id`);
    expect(events).toHaveLength(1);
  });

  test("webhook: an amount that differs from our row is never confirmed", async ({ request, page }) => {
    const s = await seedHeldPayment();
    await page.goto(`/en/c/${s.slug}/pay/${s.token}`);
    await page.getByTestId("pay-button").click();
    await page.waitForURL(/\/fake$/);
    const [row] = await rest(`payments?id=eq.${s.paymentId}&select=provider_ref`);
    const res = await request.post("/api/webhooks/moyasar", {
      data: {
        id: `evt-${randomUUID()}`,
        type: "payment_paid",
        secret_token: FAKE_SECRET,
        data: { id: `fake_paid_100_SAR_${row.provider_ref}`, invoice_id: row.provider_ref },
      },
    });
    expect(res.status()).toBe(200);
    expect(await apptStatus(s.appointmentId)).toBe("pending_payment");
    expect(await payStatus(s.paymentId)).toBe("refund_due");
  });

  for (const locale of ["ar", "en"] as const) {
    for (const width of [360, 1280]) {
      test(`${locale} at ${width}px: pay and result pages, direction, no page-level overflow`, async ({ page }, testInfo) => {
        const s = await seedHeldPayment();
        await page.setViewportSize({ width, height: width === 360 ? 780 : 900 });
        await page.goto(`/${locale}/c/${s.slug}/pay/${s.token}`, { waitUntil: "networkidle" });
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        await expect(page.getByTestId("pay-button")).toBeVisible();
        if (locale === "ar") await expect(page.getByTestId("pay-amount")).toContainText(/[٠-٩]/);
        else await expect(page.getByTestId("pay-amount")).toContainText(/\d/);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await testInfo.attach(`pay-${locale}-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

        await page.goto(`/${locale}/c/${s.slug}/pay/${s.token}/result`, { waitUntil: "networkidle" });
        await expect(page.getByTestId("pay-status")).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
      });
    }
  }
});
