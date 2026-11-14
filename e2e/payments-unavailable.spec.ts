import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { SERVICE_KEY, SUPABASE_URL, rest } from "./helpers/tenant";

/**
 * A deposit clinic on a server with NO payment provider configured (the "no-payments" project in
 * playwright.config.ts: port 3001, no PAYMENT_PROVIDER, no Moyasar key, no ALLOW_FAKE_PAYMENTS: the same
 * situation as production before the Moyasar test keys exist). The booking must be refused up front:
 * nothing is created, no slot is held, the phone limit is not consumed, and the visitor gets an honest message.
 */
const phoneKey = (tenantId: string, e164: string) =>
  `book-phone:${tenantId}:${createHash("sha256").update(e164).digest("hex")}`;

async function appointmentsFor(e164: string): Promise<number> {
  const cust = (await rest(`customers?phone=eq.${encodeURIComponent(e164)}&select=id`)) as { id: string }[];
  let n = 0;
  for (const c of cust) n += ((await rest(`appointments?customer_id=eq.${c.id}&select=id`)) as unknown[]).length;
  return n + cust.length * 1000; // any customer row at all counts as "something was created"
}

async function demoClinic() {
  const [tenant] = await rest("tenants?slug=eq.demo-clinic&select=id");
  return tenant.id as string;
}

test.describe("deposit clinic without a payment provider", () => {
  test.skip(!SUPABASE_URL || !SERVICE_KEY, "needs the local Supabase stack");
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "no-payments", "runs once, on the server without a payment provider");
  });
  test.beforeAll(async () => {
    await rest("rate_limits?key=like.*", { method: "DELETE" });
  });

  test("web form: friendly message, nothing created, phone limit untouched", async ({ page }) => {
    const digits = Math.floor(Math.random() * 1e8).toString().padStart(8, "0");
    const e164 = `+9665${digits}`;
    await page.goto("/en/c/demo-clinic");
    await page.getByText("Check-up & Exam", { exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    const slot = page.locator('input[name="slot-choice"]').first();
    await slot.waitFor({ state: "attached" });
    await slot.check({ force: true });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Full name").fill("No Pay Tester");
    await page.getByLabel("Mobile number").fill(`05${digits}`);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Confirm booking" }).click();

    await expect(page.getByRole("form").getByRole("alert")).toContainText("Online payment is not available yet");
    await expect(page.getByRole("form").getByRole("alert")).toContainText("contact the clinic");
    expect(page.url()).not.toMatch(/\/pay\//);
    await expect(page.getByTestId("pay-button")).toHaveCount(0);

    expect(await appointmentsFor(e164)).toBe(0);
    const limit = await rest(`rate_limits?key=eq.${encodeURIComponent(phoneKey(await demoClinic(), e164))}&select=key`);
    expect(limit).toEqual([]);
  });

  test("chat: the assistant gets an honest payments_unavailable result and no booking exists", async ({ page }) => {
    await page.setExtraHTTPHeaders({ "x-dawrak-e2e-model": "1" });
    const tenantId = await demoClinic();
    const [service] = await rest(`services?tenant_id=eq.${tenantId}&select=id&limit=1`);
    const from = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10);
    const slots = (await rest("rpc/get_available_slots", {
      method: "POST",
      body: JSON.stringify({ p_tenant_id: tenantId, p_provider_id: null, p_service_id: service.id, p_date_from: from, p_date_to: to, p_step_min: 30 }),
    })) as { slot_provider_id: string; slot_start: string }[];
    expect(slots.length).toBeGreaterThan(0);
    const e164 = `+9665${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
    const lp = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(slots[0].slot_start));
    const g = (t: string) => lp.find((x) => x.type === t)!.value;
    // prepare_booking refuses BEFORE asking the visitor to confirm: no summary, no token, no booking
    const cmd = `PREPARE ${JSON.stringify({ service_id: service.id, provider_id: slots[0].slot_provider_id, date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}`, full_name: "Chat NoPay", phone: e164 })}`;

    await sendChat(page, cmd);
    const reply = page.getByTestId("chat-widget").getByText(/RESULT /);
    await expect(reply).toBeVisible({ timeout: 30_000 });
    const text = await reply.innerText();
    expect(text).toContain('"error":"payments_unavailable"');
    expect(text).toContain('"ok":false');
    expect(text).toContain("NO booking was made");
    expect(text).not.toContain("confirmation_token");
    expect(text).not.toContain("pay_url");
    expect(text).not.toContain("appointment_id");

    expect(await appointmentsFor(e164)).toBe(0);
    expect(await rest(`rate_limits?key=eq.${encodeURIComponent(phoneKey(tenantId, e164))}&select=key`)).toEqual([]);
  });
});

async function sendChat(page: Page, message: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/en/c/demo-clinic", { waitUntil: "networkidle" });
  const chat = page.getByTestId("chat-widget");
  await chat.getByLabel("Your message to the assistant").fill(message);
  await chat.getByRole("button", { name: "Send" }).click();
}
