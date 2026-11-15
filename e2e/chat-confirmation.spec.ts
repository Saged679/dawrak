import { ownIpHeaders } from "./helpers/site";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * The server-enforced two-phase confirmation, driven through the real widget, route and tools with the offline
 * scripted model (DAWRAK_MOCK_CHAT_MODEL=1). The scripted model plays both a well-behaved model (PREPARE, then
 * the Confirm tap) and a misbehaving one (BOOKNOW: calls create_booking straight away, with no token).
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

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation", ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rest ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const phones: string[] = [];

test.describe("chat confirmation protocol (widget + mock model)", () => {
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

  async function details() {
    const [tenant] = await rest("tenants?slug=eq.demo-salon&select=id");
    const [service] = await rest(`services?tenant_id=eq.${tenant.id}&select=id&limit=1`);
    const from = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10);
    const slots = (await rest("rpc/get_available_slots", {
      method: "POST",
      body: JSON.stringify({ p_tenant_id: tenant.id, p_provider_id: null, p_service_id: service.id, p_date_from: from, p_date_to: to, p_step_min: 30 }),
    })) as { slot_provider_id: string; slot_start: string }[];
    expect(slots.length).toBeGreaterThan(0);
    const slot = slots[Math.floor(Math.random() * slots.length)];
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(slot.slot_start));
    const g = (t: string) => parts.find((x) => x.type === t)!.value;
    const phone = `+9665${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
    phones.push(phone);
    return {
      phone,
      body: { service_id: service.id, provider_id: slot.slot_provider_id, date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}`, full_name: "Chat Tester", phone },
    };
  }
  const bookedFor = async (phone: string) => {
    const cust = (await rest(`customers?phone=eq.${encodeURIComponent(phone)}&select=id`)) as { id: string }[];
    return cust.length;
  };
  async function open(page: Page) {
    await page.setExtraHTTPHeaders(ownIpHeaders({ "x-dawrak-e2e-model": "1" }));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/en/c/demo-salon", { waitUntil: "networkidle" });
    return page.getByTestId("chat-widget");
  }

  test("happy path: summary, Confirm / Change quick replies (keyboard accessible), booking only after the tap", async ({ page }) => {
    const { phone, body } = await details();
    const chat = await open(page);
    await chat.getByLabel("Your message to the assistant").fill(`PREPARE ${JSON.stringify(body)}`);
    await chat.getByRole("button", { name: "Send" }).click();
    // The card shows the SERVER's summary. The mock model's own words are a different paraphrase on purpose.
    const card = chat.getByTestId("chat-summary");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("Booking summary:");
    await expect(card).toContainText(`Phone: ${phone}`);
    await expect(card).toContainText("Name: Chat Tester");
    await expect(card).toContainText(`(${body.time})`); // the business-local time the server will book
    await expect(chat.getByText("Mock paraphrase: I have prepared your appointment, please use the buttons.")).toBeVisible();
    await expect(card).not.toContainText("Mock paraphrase");
    await expect(chat.getByText(/RESULT/)).toHaveCount(0); // the raw tool JSON (and the token) is never shown
    expect(await bookedFor(phone)).toBe(0); // prepare changed nothing

    const group = chat.getByRole("group", { name: "Confirm or change the summary" });
    await expect(group).toBeVisible();
    const confirm = group.getByRole("button", { name: "Confirm" });
    await expect(group.getByRole("button", { name: "Change" })).toBeVisible();
    await confirm.focus();
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter"); // the keyboard works the same as a tap
    await expect(chat.getByText(/RESULT .*confirmation_email/)).toBeVisible({ timeout: 30_000 });
    expect(await bookedFor(phone)).toBe(1);
    await expect(group).toHaveCount(0); // the buttons go away once answered
  });

  test("the Change button books nothing", async ({ page }) => {
    const { phone, body } = await details();
    const chat = await open(page);
    await chat.getByLabel("Your message to the assistant").fill(`PREPARE ${JSON.stringify(body)}`);
    await chat.getByRole("button", { name: "Send" }).click();
    await expect(chat.getByTestId("chat-summary")).toBeVisible({ timeout: 30_000 });
    await expect(chat.getByTestId("quick-change")).toBeVisible();
    await chat.getByTestId("quick-change").click();
    await expect(chat.getByText("Hello from the mock assistant.")).toBeVisible({ timeout: 30_000 });
    expect(await bookedFor(phone)).toBe(0);
  });

  test("Confirm and Change exist only together with the server summary card", async ({ page }) => {
    const { body } = await details();
    const chat = await open(page);
    await expect(chat.getByTestId("chat-quick-replies")).toHaveCount(0); // nothing pending: no buttons
    await chat.getByLabel("Your message to the assistant").fill("hello");
    await chat.getByRole("button", { name: "Send" }).click();
    await expect(chat.getByText("Hello from the mock assistant.")).toBeVisible({ timeout: 30_000 });
    await expect(chat.getByTestId("chat-quick-replies")).toHaveCount(0);
    await expect(chat.getByTestId("chat-summary")).toHaveCount(0);
    await chat.getByLabel("Your message to the assistant").fill(`PREPARE ${JSON.stringify(body)}`);
    await chat.getByRole("button", { name: "Send" }).click();
    await expect(chat.getByTestId("chat-summary")).toBeVisible({ timeout: 30_000 });
    await expect(chat.getByTestId("chat-quick-replies")).toBeVisible();
    // the next visitor message removes both again
    await chat.getByLabel("Your message to the assistant").fill("what are your hours");
    await chat.getByRole("button", { name: "Send" }).click();
    await expect(chat.getByTestId("chat-quick-replies")).toHaveCount(0, { timeout: 30_000 });
    await expect(chat.getByTestId("chat-summary")).toHaveCount(0);
  });

  test("a premature create_booking (no prepare, no token) is blocked, and the model is told to ask for confirmation", async ({ page }) => {
    const { phone, body } = await details();
    const chat = await open(page);
    await chat.getByLabel("Your message to the assistant").fill(`BOOKNOW ${JSON.stringify(body)}`);
    await chat.getByRole("button", { name: "Send" }).click();
    // The turn guard (src/lib/agent/turn-guard.ts) replaces the model's raw "RESULT ... confirmation_required"
    // text with a safe, honest sentence: nothing was booked, ask the visitor to confirm again.
    await expect(chat.getByText("That has not gone through yet: no appointment was booked", { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(chat.getByText(/RESULT .*confirmation_required/)).toHaveCount(0);
    expect(await bookedFor(phone)).toBe(0);
  });
});
