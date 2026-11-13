import { randomBytes } from "node:crypto";
import { loginFixed } from "./helpers/tenant";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Reminders, patient page, request-a-link, demo mailbox and the cron endpoint, against the LOCAL
 * Supabase stack. The server runs with MAIL_PROVIDER=resend and NO Resend key (playwright.config.ts):
 * a real send would fail, so every mail that shows up in a mailbox proves demo tenants use the outbox.
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
const CRON_SECRET = "dawrak-e2e-cron-secret-0123456789"; // same literal as playwright.config.ts

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

const phone8 = () => Math.floor(Math.random() * 1e8).toString().padStart(8, "0");
const customers: string[] = [];
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** A confirmed future appointment for a fresh customer, created straight in the database. */
async function seedCustomer(slug: "demo-clinic" | "demo-salon" = "demo-salon", email: string | null = "seed@example.com") {
  const [tenant] = await rest(`tenants?slug=eq.${slug}&select=id`);
  const [service] = await rest(`services?tenant_id=eq.${tenant.id}&select=id,price&limit=1`);
  const [provider] = await rest(`providers?tenant_id=eq.${tenant.id}&select=id&limit=1`);
  const local = `05${phone8()}`;
  const [customer] = await rest("customers", {
    method: "POST",
    body: JSON.stringify({ tenant_id: tenant.id, full_name: "Seed Tester", phone: `+966${local.slice(1)}`, email, locale: "en" }),
  });
  customers.push(customer.id);
  let appt: { id: string } | undefined;
  for (let i = 0; i < 8 && !appt; i++) {
    const start = new Date(Date.now() + (20 + Math.floor(Math.random() * 60)) * 86_400_000);
    start.setUTCHours(Math.floor(Math.random() * 5), [0, 30][Math.floor(Math.random() * 2)], 0, 0); // 03:00-08:00 Riyadh: before opening hours
    try {
      [appt] = await rest("appointments", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: tenant.id,
      provider_id: provider.id,
      service_id: service.id,
      customer_id: customer.id,
      starts_at: start.toISOString(),
      ends_at: new Date(start.getTime() + 1_800_000).toISOString(),
      status: "confirmed",
      source: "web",
      price: service.price,
    }),
  });
    } catch (e) {
      if (!String(e).includes("23P01")) throw e;
    }
  }
  if (!appt) throw new Error("could not place a seed appointment");
  const [{ access_token: token }] = await rest(`customers?id=eq.${customer.id}&select=access_token`);
  return { slug, token: token as string, customerId: customer.id as string, appointmentId: appt.id as string, local };
}

test.describe("reminders, patient page and demo mailbox", () => {
  test.skip(!SUPABASE_URL || !SERVICE_KEY, "needs the local Supabase stack");
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "runs once; viewports are set explicitly");
  });
  test.beforeAll(async () => {
    await rest("rate_limits?key=like.*", { method: "DELETE" });
  });
  test.afterAll(async () => {
    for (const id of customers) {
      await rest(`appointments?customer_id=eq.${id}`, { method: "DELETE" });
      await rest(`customers?id=eq.${id}`, { method: "DELETE" });
    }
  });

  test("new customer books, lands on the patient page, gets the mail in THEIR mailbox, reschedules, is reminded by cron, cancels", async ({ page, browser }) => {
    const phone = `05${phone8()}`;
    const email = `rt-${randomBytes(4).toString("hex")}@example.com`;
    await page.goto("/en/c/demo-salon");
    await page.getByText("Cut & Style", { exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    // a day a few days out, so both reminders are in the future and the 2h change window is open
    const day = page.locator('input[name="day-choice"]:not([disabled])').nth(3);
    await day.waitFor({ state: "attached" });
    await day.check({ force: true });
    await page.locator('input[name="slot-choice"]').first().check({ force: true });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Full name").fill("Flow <b>Tester</b>");
    await page.getByLabel("Mobile number").fill(phone);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Confirm booking" }).click();

    // brand-new customer: server-side redirect to the patient page, which confirms and explains the link
    await page.waitForURL(/\/en\/c\/demo-salon\/my\/[0-9a-f]{48}\?booked=[0-9a-f-]{36}$/);
    const myUrl = page.url().split("?")[0];
    const e164 = `+966${phone.slice(1)}`;
    const [cust] = await rest(`customers?phone=eq.${encodeURIComponent(e164)}&select=id`);
    customers.push(cust.id);
    await expect(page.getByRole("heading", { name: "Your booking is confirmed" })).toBeVisible();
    await expect(page.getByTestId("manage-link-note")).toContainText("Bookmark");
    await expect(page.getByTestId("portal-appointment")).toHaveCount(1);
    await expect(page.getByTestId("portal-status")).toHaveText("Confirmed");

    // privacy headers and meta on the page that carries the token
    const res = await page.goto(myUrl);
    expect(res?.status()).toBe(200);
    expect(res?.headers()["referrer-policy"]).toBe("no-referrer");
    expect(res?.headers()["cache-control"]).toContain("no-store");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const apptId = (await rest(`appointments?customer_id=eq.${cust.id}&select=id`))[0].id as string;
    const reminders = await rest(`reminders?appointment_id=eq.${apptId}&select=kind,status&order=kind`);
    expect(reminders.map((r: { kind: string; status: string }) => `${r.kind}:${r.status}`)).toEqual(["24h:pending", "2h:pending"]);

    // the booking mail is in this visitor's mailbox, as escaped plain text
    await page.goto("/en/demo/mailbox");
    await expect(page.getByTestId("mailbox-notice")).toContainText("do not enter real data");
    await expect(page.getByTestId("mailbox-message")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Your booking at Lamsa Ladies Salon" })).toBeVisible();
    await expect(page.getByTestId("mailbox-message")).toContainText("Flow <b>Tester</b>"); // shown literally, not rendered
    expect(await page.locator("[data-testid=mailbox-message] b").count()).toBe(0);
    await expect(page.getByTestId("mailbox-message").getByRole("link")).toHaveAttribute("href", myUrl);

    // a second visitor (fresh browser context) sees an empty mailbox
    const other = await browser.newContext();
    const op = await other.newPage();
    await op.goto("/en/demo/mailbox");
    await expect(op.getByTestId("mailbox-empty")).toBeVisible();
    await expect(op.getByTestId("mailbox-message")).toHaveCount(0);
    await expect(op.locator("body")).not.toContainText("Lamsa Ladies Salon");
    // ... also with a made-up session cookie
    await other.addCookies([{ name: "dawrak_demo_session", value: randomBytes(32).toString("base64url"), url: "http://localhost:3000" }]);
    await op.reload();
    await expect(op.getByTestId("mailbox-empty")).toBeVisible();
    await other.close();

    // reschedule from the patient page (native form posts, no client JS needed)
    await page.goto(myUrl);
    await page.getByTestId("reschedule-link").click();
    await expect(page.getByTestId("reschedule-panel")).toBeVisible();
    // a later day, so both reminders stay in the future
    await page.getByTestId("reschedule-panel").getByRole("navigation").getByRole("link").last().click();
    await page.waitForURL(/day=\d{4}-\d{2}-\d{2}/);
    await page.locator('input[name="startsAt"]').last().check({ force: true });
    await page.getByTestId("reschedule-confirm").click();
    await expect(page.getByTestId("portal-done")).toContainText("moved to the new time");
    const moved = await rest(`reminders?appointment_id=eq.${apptId}&select=kind,status,send_at`);
    expect(moved.every((r: { status: string }) => r.status === "pending"), JSON.stringify(moved)).toBe(true);

    // cron: 401 without / with a wrong secret (and nothing is sent), 200 with it and the due reminder goes out
    await rest(`reminders?appointment_id=eq.${apptId}&kind=eq.24h`, {
      method: "PATCH",
      body: JSON.stringify({ send_at: new Date(Date.now() - 60_000).toISOString() }),
    });
    for (const auth of [undefined, "Bearer wrong", `Bearer ${CRON_SECRET}x`]) {
      const r = await page.request.post("/api/cron/reminders", { headers: auth ? { authorization: auth } : {} });
      expect(r.status(), String(auth)).toBe(401);
    }
    expect((await rest(`reminders?appointment_id=eq.${apptId}&kind=eq.24h&select=status`))[0].status).toBe("pending");
    const ok = await page.request.post("/api/cron/reminders", { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    expect(ok.status()).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(body.sent).toBeGreaterThanOrEqual(1);
    expect((await rest(`reminders?appointment_id=eq.${apptId}&kind=eq.24h&select=status,attempts`))[0]).toMatchObject({ status: "sent", attempts: 1 });
    expect((await rest(`reminders?appointment_id=eq.${apptId}&kind=eq.2h&select=status`))[0].status).toBe("pending");

    // the reminder is in the same visitor's mailbox. M1: a still-valid link is REUSED (not rotated), so the
    // same link keeps working and cannot be invalidated by someone else asking for a link
    await page.goto("/en/demo/mailbox");
    await expect(page.getByTestId("mailbox-message")).toHaveCount(2);
    const reminder = page.getByTestId("mailbox-message").filter({ hasText: "Reminder: your appointment tomorrow" });
    await expect(reminder).toContainText("Hijri:");
    const freshUrl = await reminder.getByRole("link").getAttribute("href");
    expect(freshUrl).toMatch(/\/en\/c\/demo-salon\/my\/[0-9a-f]{48}$/);
    expect(freshUrl).toBe(myUrl);
    expect((await page.goto(myUrl))?.status()).toBe(200);

    // cancel with the link
    await page.goto(freshUrl!);
    await page.getByText("Cancel this appointment", { exact: true }).click();
    await page.getByTestId("cancel-confirm").click();
    await expect(page.getByTestId("portal-done")).toContainText("cancelled");
    expect((await rest(`appointments?id=eq.${apptId}&select=status,cancel_reason`))[0]).toMatchObject({ status: "cancelled", cancel_reason: "customer" });
    expect((await rest(`reminders?appointment_id=eq.${apptId}&kind=eq.2h&select=status`))[0].status).toBe("cancelled");
  });

  test("tokens: wrong clinic, expired, malformed and guessed URLs are all a bare 404", async ({ page }) => {
    const s = await seedCustomer("demo-salon");
    expect((await page.goto(`/en/c/demo-salon/my/${s.token}`))?.status()).toBe(200);
    const bad = [
      `/en/c/demo-clinic/my/${s.token}`, // valid token under another clinic's path
      `/ar/c/demo-clinic/my/${s.token}`,
      `/en/c/demo-salon/my/${s.token.toUpperCase()}`,
      `/en/c/demo-salon/my/${s.token.slice(1)}`,
      `/en/c/demo-salon/my/${s.token}0`,
      `/en/c/demo-salon/my/${randomBytes(24).toString("hex")}`,
      `/en/c/demo-salon/my/${s.customerId}`, // a row id is not a credential
      `/en/c/demo-salon/my/${s.appointmentId}`,
      `/en/c/demo-salon/my/1`,
      `/en/c/does-not-exist/my/${s.token}`,
    ];
    for (const path of bad) expect((await page.goto(path))?.status(), path).toBe(404);
    await expect(page.locator("body")).not.toContainText("Seed Tester");

    await rest(`customers?id=eq.${s.customerId}`, {
      method: "PATCH",
      body: JSON.stringify({ access_token_expires_at: new Date(Date.now() - 1000).toISOString() }),
    });
    expect((await page.goto(`/en/c/demo-salon/my/${s.token}`))?.status()).toBe(404);
  });

  test("request a link: same neutral answer for the visitor's own customer and unknown contacts; the mail lands in the visitor's own mailbox", async ({ page, browser }) => {
    // H2: in a demo tenant only the visitor session that CREATED the customer can pull its link, so the
    // customer is created by this visitor through the booking form (not seeded with the service role).
    const phone = `05${phone8()}`;
    const email = `known-${randomBytes(4).toString("hex")}@example.com`;
    await page.goto("/en/c/demo-salon");
    await page.getByText("Cut & Style", { exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    const day = page.locator('input[name="day-choice"]:not([disabled])').nth(4);
    await day.waitFor({ state: "attached" });
    await day.check({ force: true });
    await page.locator('input[name="slot-choice"]').first().check({ force: true });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Full name").fill("Link Tester");
    await page.getByLabel("Mobile number").fill(phone);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await page.waitForURL(/\/en\/c\/demo-salon\/my\/[0-9a-f]{48}\?booked=/);
    const [cust] = await rest(`customers?phone=eq.${encodeURIComponent(`+966${phone.slice(1)}`)}&select=id`);
    customers.push(cust.id);

    const ask = async (p: Page, contact: string) => {
      await p.goto("/en/c/demo-salon/my");
      await p.getByLabel("Mobile number or e-mail").fill(contact);
      await p.getByRole("button", { name: "Send me the link" }).click();
      await p.waitForURL(/\/my\?sent=1$/);
      return p.getByTestId("link-sent").innerText();
    };
    const known = await ask(page, phone);
    const unknown = await ask(page, "0500000001");
    const unknownEmail = await ask(page, "nobody-here@example.com");
    expect(known).toBe(unknown);
    expect(known).toBe(unknownEmail);
    expect(known).not.toContain("Link Tester");

    await page.goto("/en/demo/mailbox");
    const linkMail = page.getByTestId("mailbox-message").filter({ hasText: "Your link to manage your appointments at Lamsa Ladies Salon" });
    await expect.poll(async () => linkMail.count(), { timeout: 15_000 }).toBe(1); // only the visitor's own customer got a link mail
    await page.reload();
    await expect(linkMail).toContainText(email); // addressed to the contact ON FILE
    const link = await linkMail.getByRole("link").getAttribute("href");
    expect((await page.goto(link!))?.status()).toBe(200);
    await expect(page.getByTestId("portal-appointment")).toHaveCount(1);

    // nobody else sees it, and visitor B typing the same phone gets the same neutral answer but NO mail
    const other = await browser.newContext();
    const op = await other.newPage();
    await op.goto("/en/demo/mailbox");
    await expect(op.getByTestId("mailbox-empty")).toBeVisible();
    expect(await ask(op, phone)).toBe(known);
    await op.waitForTimeout(1500);
    await op.goto("/en/demo/mailbox");
    await expect(op.getByTestId("mailbox-empty")).toBeVisible();
    await other.close();

    // a customer seeded without any visitor session is not reachable in a demo tenant either
    const seeded = await seedCustomer("demo-salon", "known@example.com");
    expect(await ask(page, seeded.local)).toBe(known);

    // invalid input is a form error, not a neutral message
    await page.goto("/en/c/demo-salon/my");
    await page.getByLabel("Mobile number or e-mail").fill("abc");
    await page.getByRole("button", { name: "Send me the link" }).click();
    await expect(page.locator("main [role=alert]")).toContainText("valid");
  });

  test("owner and receptionist see today's reminder counts; the provider does not", async ({ page }) => {
    await page.goto("/en/demo");
    await page.getByTestId("demo-clinic-owner").click();
    await page.waitForURL(/\/en\/dashboard/);
    await expect(page.getByTestId("reminders-card")).toBeVisible();
    for (const k of ["pending", "sent", "failed"]) await expect(page.getByTestId(`reminders-${k}`)).toHaveText(/^\d+$/);
    await page.context().clearCookies();
    await loginFixed(page, "clinic-doctor");
    await expect(page.getByTestId("reminders-card")).toHaveCount(0);
  });

  for (const locale of ["ar", "en"] as const) {
    for (const width of [360, 1280]) {
      test(`${locale} at ${width}px: patient page, reschedule, request and mailbox pages have no page-level overflow`, async ({ page }, testInfo) => {
        const s = await seedCustomer("demo-salon");
        await page.setViewportSize({ width, height: width === 360 ? 780 : 900 });
        const urls = [
          `/${locale}/c/demo-salon/my/${s.token}`,
          `/${locale}/c/demo-salon/my/${s.token}?reschedule=${s.appointmentId}`,
          `/${locale}/c/demo-salon/my`,
          `/${locale}/demo/mailbox`,
        ];
        for (const u of urls) {
          await page.goto(u, { waitUntil: "networkidle" });
          await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
          expect(await overflow(page), u).toBeLessThanOrEqual(0);
        }
        await page.goto(urls[1], { waitUntil: "networkidle" });
        await expect(page.getByTestId("reschedule-panel")).toBeVisible();
        if (locale === "ar") await expect(page.getByTestId("portal-appointment")).toContainText(/[٠-٩]/);
        await testInfo.attach(`my-${locale}-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      });
    }
  }
});
