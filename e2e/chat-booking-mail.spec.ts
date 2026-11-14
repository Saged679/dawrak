import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Booking through the REAL chat route and tools (the server runs the offline scripted model,
 * DAWRAK_MOCK_CHAT_MODEL=1, see playwright.config.ts) on the demo clinic: the confirmation and the
 * reminders land in THIS visitor's demo mailbox and nowhere else. The server has MAIL_PROVIDER=resend
 * and no key, so any real send would fail: a mailbox row proves the outbox was used.
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
const CRON_SECRET = "dawrak-e2e-cron-secret-0123456789";

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

const phones: string[] = [];

test.describe("chat booking -> demo mailbox", () => {
  test.skip(!SUPABASE_URL || !SERVICE_KEY, "needs the local Supabase stack");
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "runs once");
  });
  test.beforeAll(async () => {
    await rest("rate_limits?key=like.*", { method: "DELETE" });
  });
  test.afterAll(async () => {
    for (const p of phones) {
      const cust = (await rest(`customers?phone=eq.${encodeURIComponent(p)}&select=id`)) as { id: string }[];
      for (const c of cust) {
        await rest(`appointments?customer_id=eq.${c.id}`, { method: "DELETE" });
        await rest(`customers?id=eq.${c.id}`, { method: "DELETE" });
      }
    }
  });

  /** Books through the chat widget; returns what the model was shown plus the DB rows. */
  async function bookInChat(page: Page, slug: "demo-clinic" | "demo-salon") {
    await page.setExtraHTTPHeaders({ "x-dawrak-e2e-model": "1" });
    const [tenant] = await rest(`tenants?slug=eq.${slug}&select=id`);
    const [service] = await rest(`services?tenant_id=eq.${tenant.id}&select=id&limit=1`);
    const from = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10);
    const slots = (await rest("rpc/get_available_slots", {
      method: "POST",
      body: JSON.stringify({ p_tenant_id: tenant.id, p_provider_id: null, p_service_id: service.id, p_date_from: from, p_date_to: to, p_step_min: 30 }),
    })) as { slot_provider_id: string; slot_start: string }[];
    expect(slots.length).toBeGreaterThan(0);
    const slot = slots[Math.floor(Math.random() * slots.length)];
    const phone = `+9665${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
    const email = `chat-${randomBytes(4).toString("hex")}@e2e-mail.dev`; // not a placeholder domain: those are dropped by the server
    phones.push(phone);
    // the server converts business-local date + time (Asia/Riyadh); the model never does
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(slot.slot_start));
    const p = (t: string) => local.find((x) => x.type === t)!.value;
    const cmd = `PREPARE ${JSON.stringify({ service_id: service.id, provider_id: slot.slot_provider_id, date: `${p("year")}-${p("month")}-${p("day")}`, time: `${p("hour")}:${p("minute")}`, full_name: "Chat Tester", phone, email })}`;

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/en/c/${slug}`, { waitUntil: "networkidle" });
    const chat = page.getByTestId("chat-widget");
    await chat.getByLabel("Your message to the assistant").fill(cmd);
    await chat.getByRole("button", { name: "Send" }).click();
    // turn 1: prepare -> summary + Confirm / Change quick replies; nothing is booked yet
    await expect(chat.getByTestId("chat-summary")).toBeVisible({ timeout: 30_000 });
    expect(await rest(`customers?phone=eq.${encodeURIComponent(phone)}&select=id`)).toEqual([]);
    // turn 2: the visitor taps Confirm (the mock model then completes the pending action from the server state)
    await chat.getByTestId("quick-confirm").click();
    const reply = chat.getByText(/RESULT .*confirmation_email/);
    await expect(reply).toBeVisible({ timeout: 30_000 });
    const text = (await reply.innerText()) ?? "";
    // exactly what the model received: honest about the mailbox, no token, no address
    expect(text).toContain('"confirmation_email":"demo_mailbox"');
    expect(text).not.toContain(email);
    expect(text).not.toMatch(/[0-9a-f]{40,}/);
    expect(text).not.toContain("customer_token");

    // the session cookie is httpOnly (not readable by page scripts)
    const cookie = (await page.context().cookies()).find((c) => c.name === "dawrak_demo_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain("dawrak_demo_session");

    const [cust] = await rest(`customers?phone=eq.${encodeURIComponent(phone)}&select=id`);
    const [appt] = await rest(`appointments?customer_id=eq.${cust.id}&select=id,source,status`);
    expect(appt.source).toBe("chat");
    const [bound] = await rest(`demo_appointment_sessions?appointment_id=eq.${appt.id}&select=session_hash`);
    expect(bound.session_hash).toBe(createHash("sha256").update(cookie!.value).digest("hex"));
    return { email, appt, text };
  }

  async function secondVisitorSeesNothing(browser: Browser) {
    const other = await browser.newContext();
    const op = await other.newPage();
    await op.goto("/en/demo/mailbox");
    await expect(op.getByTestId("mailbox-empty")).toBeVisible();
    await expect(op.getByTestId("mailbox-message")).toHaveCount(0);
    return { other, op };
  }

  test("demo clinic (deposit): the chat booking's confirmation is in this visitor's mailbox only", async ({ page, browser }) => {
    const { email, appt, text } = await bookInChat(page, "demo-clinic");
    expect(appt.status).toBe("pending_payment");
    expect(text).toContain("pay_url");
    // a held booking has no reminders yet (they start when the deposit is paid)
    expect(await rest(`reminders?appointment_id=eq.${appt.id}&select=kind`)).toEqual([]);

    await page.goto("/en/demo/mailbox");
    await expect(page.getByTestId("mailbox-message")).toHaveCount(1);
    await expect(page.getByTestId("mailbox-message")).toContainText(email);
    await expect(page.getByTestId("mailbox-message").getByRole("link")).toHaveAttribute("href", /\/en\/c\/demo-clinic\/my\/[0-9a-f]{48}$/);

    const { other } = await secondVisitorSeesNothing(browser);
    await other.close();
  });

  test("demo salon: confirmation, then the 24h reminder, land in this visitor's mailbox only", async ({ page, browser }) => {
    const { email, appt } = await bookInChat(page, "demo-salon");
    expect(appt.status).toBe("confirmed");
    const reminders = (await rest(`reminders?appointment_id=eq.${appt.id}&select=kind,status&order=kind`)) as { kind: string; status: string }[];
    expect(reminders.map((r) => `${r.kind}:${r.status}`)).toEqual(["24h:pending", "2h:pending"]);

    await page.goto("/en/demo/mailbox");
    await expect(page.getByTestId("mailbox-message")).toHaveCount(1);
    await expect(page.getByTestId("mailbox-message")).toContainText(email);
    const { other, op } = await secondVisitorSeesNothing(browser);

    await rest(`reminders?appointment_id=eq.${appt.id}&kind=eq.24h`, {
      method: "PATCH",
      body: JSON.stringify({ send_at: new Date(Date.now() - 60_000).toISOString() }),
    });
    const cron = await page.request.post("/api/cron/reminders", { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    expect(cron.status()).toBe(200);
    expect((await rest(`reminders?appointment_id=eq.${appt.id}&kind=eq.24h&select=status`))[0].status).toBe("sent");
    await page.goto("/en/demo/mailbox");
    await expect(page.getByTestId("mailbox-message")).toHaveCount(2);
    await expect(page.getByTestId("mailbox-message").filter({ hasText: "Reminder" })).toHaveCount(1);
    await op.goto("/en/demo/mailbox");
    await expect(op.getByTestId("mailbox-message")).toHaveCount(0);
    await other.close();
  });
});
