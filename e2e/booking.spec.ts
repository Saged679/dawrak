import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/** Local Supabase credentials (only used to verify and clean up rows; never committed). */
function env(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const raw = readFileSync(".env.local", "utf8");
    return raw.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
  } catch {
    return undefined;
  }
}

const SUPABASE_URL = env("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  return res.status === 204 ? null : res.json();
}

function randomSaudiPhone() {
  const n = Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, "0");
  return `05${n}`;
}

/**
 * Other specs (and the other project) book on the demo businesses in parallel, and most take the first slot of
 * the first day; the dashboard spec also needs free time on the doctor's first day. Every booking test here
 * therefore takes the first slot of its OWN later day (an index into the days that have times), so parallel runs
 * cannot collide on one slot (a collision showed up as "slot_taken" in "salon confirmed straight away") and these
 * tests never use up the free time the other specs rely on. Picking other slot indexes of the first day was
 * tried and starved the dashboard reschedule spec.
 */
async function chooseSlot(page: Page, dayIndex: number) {
  const days = page.locator('input[name="day-choice"]:not([disabled])');
  await days.first().waitFor({ state: "attached" });
  const n = await days.count();
  await days.nth(Math.min(dayIndex, n - 1)).check({ force: true });
  const slot = page.locator('input[name="slot-choice"]').first();
  await slot.waitFor({ state: "attached" });
  await slot.check({ force: true });
}

async function pickSlot(page: Page, service: string, dayIndex: number) {
  await page.getByText(service, { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click(); // service -> provider
  await page.getByRole("button", { name: "Continue" }).click(); // provider -> time
  await chooseSlot(page, dayIndex);
  await page.getByRole("button", { name: "Continue" }).click(); // time -> details
}

async function fillDetails(page: Page, name: string, phone: string) {
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Mobile number").fill(phone);
  await page.getByRole("button", { name: "Continue" }).click(); // details -> confirm
}

test.describe("public booking", () => {
  test.describe.configure({ mode: "serial" });
  const phones: string[] = [];

  test.beforeEach(({ }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "booking flow runs once, on desktop");
  });

  test.beforeAll(async () => {
    // Local runs share one IP bucket ("unknown"); reset it so repeated runs are not rate limited.
    if (SUPABASE_URL && SERVICE_KEY) await rest("rate_limits?key=like.ip:*", { method: "DELETE" });
  });

  test.afterAll(async () => {
    if (!SUPABASE_URL || !SERVICE_KEY) return;
    for (const phone of phones) {
      const e164 = `+966${phone.slice(1)}`;
      const customers = (await rest(`customers?phone=eq.${encodeURIComponent(e164)}&select=id`)) as {
        id: string;
      }[];
      for (const c of customers) {
        await rest(`appointments?customer_id=eq.${c.id}`, { method: "DELETE" });
        await rest(`customers?id=eq.${c.id}`, { method: "DELETE" });
      }
    }
  });

  test("unknown slug returns 404", async ({ page }) => {
    const res = await page.goto("/ar/c/does-not-exist");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("books the demo clinic (deposit => pending payment) and the row is in the DB", async ({ page }) => {
    const phone = randomSaudiPhone();
    phones.push(phone);
    await page.goto("/en/c/demo-clinic");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nabd Dental Clinic");
    await pickSlot(page, "Check-up & Exam", 3);
    await fillDetails(page, "E2E Tester", phone);
    await page.getByRole("button", { name: "Confirm booking" }).click();
    // deposit tenant: the booking is held and the customer is sent to the payment page
    await page.waitForURL(/\/en\/c\/demo-clinic\/pay\/[A-Za-z0-9_-]{48}$/);
    await expect(page.getByTestId("pay-button")).toBeVisible();

    if (SUPABASE_URL && SERVICE_KEY) {
      const e164 = `+966${phone.slice(1)}`;
      const rows = (await rest(
        `appointments?select=id,status,source,customers!inner(phone,full_name)&customers.phone=eq.${encodeURIComponent(e164)}`,
      )) as { status: string; source: string; customers: { full_name: string } }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending_payment");
      expect(rows[0].source).toBe("web");
      expect(rows[0].customers.full_name).toBe("E2E Tester");
    }
  });

  test("booking the same slot twice shows the friendly slot-taken message", async ({ browser }) => {
    const ctx = await browser.newContext();
    const a = await ctx.newPage();
    const b = await ctx.newPage();
    const phoneA = randomSaudiPhone();
    const phoneB = randomSaudiPhone();
    phones.push(phoneA, phoneB);

    // Both visitors look at the same slot (service + provider chosen explicitly so the slot is identical).
    for (const p of [a, b]) {
      await p.goto("/en/c/demo-clinic");
      await p.getByText("Teeth Cleaning", { exact: true }).click();
      await p.getByRole("button", { name: "Continue" }).click();
      await p.getByText("Dr. Salma Al-Harithi").click();
      await p.getByRole("button", { name: "Continue" }).click();
      await chooseSlot(p, 5);
      await p.getByRole("button", { name: "Continue" }).click();
    }
    await fillDetails(a, "First Visitor", phoneA);
    await fillDetails(b, "Second Visitor", phoneB);

    await a.getByRole("button", { name: "Confirm booking" }).click();
    // the first visitor now holds the slot and is sent to the payment page
    await a.waitForURL(/\/pay\/[A-Za-z0-9_-]{48}$/);

    await b.getByRole("button", { name: "Confirm booking" }).click();
    await expect(b.getByRole("form").getByRole("alert")).toContainText("that time was just booked");
    await expect(b.getByRole("button", { name: "Pick another time" })).toBeVisible();
    await ctx.close();
  });

  test("salon without deposit is confirmed straight away", async ({ page }) => {
    const phone = randomSaudiPhone();
    phones.push(phone);
    await page.goto("/en/c/demo-salon");
    await pickSlot(page, "Cut & Style", 4);
    await fillDetails(page, "Salon Tester", phone);
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("heading", { name: "Your booking is confirmed" })).toBeVisible();
    await expect(page.getByTestId("payment-placeholder")).toHaveCount(0);
  });

  test("invalid phone shows an inline error and does not advance", async ({ page }) => {
    await page.goto("/en/c/demo-salon");
    await pickSlot(page, "Cut & Style", 0);
    await fillDetails(page, "X Y", "12345");
    await expect(page.getByText("Enter a valid Saudi or Egyptian mobile number.")).toBeVisible();
    await expect(page.getByLabel("Mobile number")).toHaveAttribute("aria-invalid", "true");
  });
});

function sse(chunks: object[]) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

test.describe("chat widget (mocked /api/chat)", () => {
  test.beforeEach(({ }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "chat runs once, on desktop");
  });

  test("sends the right body and renders the streamed reply", async ({ page }) => {
    let body: unknown;
    await page.route("**/api/chat", async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
          "x-conversation-id": "11111111-1111-4111-8111-111111111111",
        },
        body: sse([
          { type: "start" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "A cleaning " },
          { type: "text-delta", id: "t1", delta: "costs 300 SAR." },
          { type: "text-end", id: "t1" },
          { type: "finish" },
        ]),
      });
    });
    await page.goto("/en/c/demo-clinic");
    const chat = page.getByTestId("chat-widget");
    await chat.getByLabel("Your message to the assistant").fill("How much is a cleaning?");
    await chat.getByRole("button", { name: "Send" }).click();
    await expect(chat.getByText("A cleaning costs 300 SAR.")).toBeVisible();
    expect(body).toMatchObject({
      tenantSlug: "demo-clinic",
      locale: "en",
      message: { type: "text", text: "How much is a cleaning?" },
    });
    await expect(chat.getByRole("button", { name: "Record a voice note" })).toBeEnabled();

    // Second message reuses the conversation id the server returned.
    await chat.getByLabel("Your message to the assistant").fill("Thanks");
    await chat.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => (body as { conversationId?: string }).conversationId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  test("shows a friendly rate-limit state", async ({ page }) => {
    await page.route("**/api/chat", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "rate_limited", message: "x", retryAfterSeconds: 600 } }),
      }),
    );
    await page.goto("/ar/c/demo-clinic");
    const chat = page.getByTestId("chat-widget");
    await chat.getByLabel("رسالتك إلى المساعد").fill("مرحبا");
    await chat.getByRole("button", { name: "إرسال" }).click();
    await expect(page.getByTestId("chat-error")).toContainText("انتظر بضع دقائق");
  });

  test("real API without a Gemini key reports not configured", async ({ page }) => {
    await page.goto("/en/c/demo-clinic");
    const chat = page.getByTestId("chat-widget");
    await chat.getByLabel("Your message to the assistant").fill("hello");
    await chat.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("chat-error")).toBeVisible();
  });
});

test.describe("layout", () => {
  test.beforeEach(({ }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "viewports are set explicitly");
  });

  for (const locale of ["ar", "en"] as const) {
    for (const width of [360, 1280]) {
      test(`${locale} at ${width}px: direction, no horizontal scroll, screenshot`, async ({ page }, testInfo) => {
        const next = locale === "ar" ? "متابعة" : "Continue";
        const overflow = () =>
          page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        await page.setViewportSize({ width, height: width === 360 ? 780 : 900 });
        await page.goto(`/${locale}/c/demo-clinic`, { waitUntil: "networkidle" });
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        expect(await overflow()).toBeLessThanOrEqual(0);

        // Walk to the date/time step (the widest one: horizontally scrolling day chips).
        await page.locator('label:has(input[name="service-choice"])').first().click();
        await page.getByRole("button", { name: next }).click();
        await page.getByRole("button", { name: next }).click();
        await page.locator('label:has(input[name="slot-choice"])').first().click();
        expect(await overflow()).toBeLessThanOrEqual(0);
        await testInfo.attach(`${locale}-${width}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });

        // Chat is a floating button on phones (opens full screen) and a side column on desktop.
        if (width === 360) {
          await page.getByRole("button", { name: locale === "ar" ? "افتح المحادثة مع المساعد" : "Open the assistant chat" }).click();
          await expect(page.getByTestId("chat-widget")).toBeVisible();
          await expect(page.getByTestId("chat-widget").getByRole("textbox")).toBeVisible();
          expect(await overflow()).toBeLessThanOrEqual(0);
        } else {
          await expect(page.getByTestId("chat-widget")).toBeVisible();
        }
      });
    }
  }
});
