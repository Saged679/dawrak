import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json";
import en from "../messages/en.json";
import { clearRateLimits, hasLocalDb, rest } from "./helpers/tenant";

/**
 * Invalid input on the public booking form (web): bad phone / email / name, a start time in the past, outside the
 * working hours or more than 90 days ahead, a malformed time and a taken slot. The hidden `startsAt` is changed in
 * the DOM, which is exactly what a hostile client can send, so the server (not the picker) is what is under test.
 * English and Arabic; runs on both the desktop and the phone project (Pixel 7).
 */
const MSG = { en: en.Booking, ar: ar.Booking } as const;
type Loc = keyof typeof MSG;

const cleanup: string[] = [];
const phone = () => `05${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
const e164 = (p: string) => encodeURIComponent(`+966${p.slice(1)}`);

test.describe("booking form: invalid input", () => {
  test.skip(!hasLocalDb(), "needs the local Supabase stack");
  test.beforeEach(async () => {
    await clearRateLimits();
  });
  test.afterAll(async () => {
    for (const p of cleanup) {
      const rows = (await rest(`customers?phone=eq.${e164(p)}&select=id`)) as { id: string }[];
      for (const c of rows) {
        await rest(`appointments?customer_id=eq.${c.id}`, { method: "DELETE" });
        await rest(`customers?id=eq.${c.id}`, { method: "DELETE" });
      }
    }
  });

  /** Walks the demo salon (no deposit) up to the details step. */
  async function toDetails(page: Page, loc: Loc, dayIndex: number) {
    const m = MSG[loc];
    await page.goto(`/${loc}/c/demo-salon`);
    await page.locator('label:has(input[name="service-choice"])').first().click();
    await page.getByRole("button", { name: m.continue }).click();
    await page.getByRole("button", { name: m.continue }).click();
    const days = page.locator('label:has(input[name="day-choice"]:not([disabled]))');
    await days.first().waitFor({ state: "attached" });
    const day = days.nth(Math.min(dayIndex, (await days.count()) - 1));
    await day.click();
    await expect(day.locator("input")).toBeChecked();
    const slot = page.locator('label:has(input[name="slot-choice"])').first();
    await slot.click();
    await expect(slot.locator("input")).toBeChecked();
    await page.getByRole("button", { name: m.continue }).click();
  }
  async function details(page: Page, loc: Loc, name: string, ph: string, email = "") {
    const m = MSG[loc];
    await page.getByLabel(m.name).fill(name);
    await page.getByLabel(m.phone).fill(ph);
    if (email) await page.getByLabel(m.email).fill(email);
    await page.getByRole("button", { name: m.continue }).click();
  }
  const tamper = (page: Page, iso: () => string) =>
    page.locator('input[name="startsAt"]').evaluate((el: HTMLInputElement, v) => {
      el.value = v;
    }, iso());

  for (const loc of ["en", "ar"] as const) {
    const m = MSG[loc];

    for (const bad of ["12345", "0412345678", "+1 202 555 0100", "abcdefghij"]) {
      test(`${loc}: bad phone "${bad}" is refused inline and the confirm step is not reached`, async ({ page }) => {
        await toDetails(page, loc, 1);
        await details(page, loc, "Bad Phone", bad);
        await expect(page.getByText(m.fieldErrors.phone)).toBeVisible();
        await expect(page.getByLabel(m.phone)).toHaveAttribute("aria-invalid", "true");
        await expect(page.getByRole("button", { name: m.submit })).toHaveCount(0);
      });
    }

    test(`${loc}: bad e-mail is refused inline`, async ({ page }) => {
      await toDetails(page, loc, 1);
      await details(page, loc, "Bad Mail", phone(), "not-an-email");
      await expect(page.getByText(m.fieldErrors.email)).toBeVisible();
      await expect(page.getByRole("button", { name: m.submit })).toHaveCount(0);
    });

    test(`${loc}: a one-character name is refused`, async ({ page }) => {
      await toDetails(page, loc, 1);
      await details(page, loc, "X", phone());
      await expect(page.getByText(m.fieldErrors.fullName)).toBeVisible();
      await expect(page.getByRole("button", { name: m.submit })).toHaveCount(0);
    });

    test(`${loc}: a start time in the past is rejected by the server and nothing is created`, async ({ page }) => {
      const ph = phone();
      cleanup.push(ph);
      await toDetails(page, loc, 2);
      await details(page, loc, "Past Tester", ph);
      await tamper(page, () => new Date(Date.now() - 86_400_000).toISOString());
      await page.getByRole("button", { name: m.submit }).click();
      await expect(page.getByRole("form").getByRole("alert")).toContainText(m.errors.slot_taken.slice(0, 18));
      expect(await rest(`customers?phone=eq.${e164(ph)}&select=id`)).toHaveLength(0);
    });

    test(`${loc}: a start time outside the working hours (03:00 Riyadh) is rejected`, async ({ page }) => {
      const ph = phone();
      cleanup.push(ph);
      await toDetails(page, loc, 2);
      await details(page, loc, "Night Tester", ph);
      await tamper(page, () => {
        const d = new Date(Date.now() + 10 * 86_400_000);
        d.setUTCHours(0, 0, 0, 0); // 03:00 in Asia/Riyadh
        return d.toISOString();
      });
      await page.getByRole("button", { name: m.submit }).click();
      await expect(page.getByRole("form").getByRole("alert")).toContainText(m.errors.slot_taken.slice(0, 18));
      expect(await rest(`customers?phone=eq.${e164(ph)}&select=id`)).toHaveLength(0);
    });
  }

  test("en: more than 90 days ahead gives the too-far message", async ({ page }) => {
    await toDetails(page, "en", 2);
    await details(page, "en", "Far Tester", phone());
    await tamper(page, () => new Date(Date.now() + 120 * 86_400_000).toISOString());
    await page.getByRole("button", { name: en.Booking.submit }).click();
    await expect(page.getByRole("form").getByRole("alert")).toContainText("90 days");
  });

  test("en: a malformed start time is an invalid-input error, not a crash", async ({ page }) => {
    await toDetails(page, "en", 2);
    await details(page, "en", "Garbage Tester", phone());
    await tamper(page, () => "tomorrow-ish");
    await page.getByRole("button", { name: en.Booking.submit }).click();
    await expect(page.getByRole("form").getByRole("alert")).toContainText(en.Booking.errors.invalid);
  });

  test("en: a slot that is taken behind the page's back shows the friendly message and offers another time", async ({ page }) => {
    const ph = phone();
    cleanup.push(ph);
    await toDetails(page, "en", 3);
    await details(page, "en", "Taken Tester", ph);
    const startsAt = await page.locator('input[name="startsAt"]').inputValue();
    const providerId = await page.locator('input[name="providerId"]').inputValue();
    const serviceId = await page.locator('input[name="serviceId"]').inputValue();
    const [svc] = (await rest(`services?id=eq.${serviceId}&select=tenant_id,duration_min,price`)) as { tenant_id: string; duration_min: number; price: number }[];
    const [blocker] = (await rest("customers", {
      method: "POST",
      body: JSON.stringify({ tenant_id: svc.tenant_id, full_name: "Blocker", phone: `+9665${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}` }),
    })) as { id: string }[];
    try {
      await rest("appointments", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: svc.tenant_id, provider_id: providerId, service_id: serviceId, customer_id: blocker.id,
          starts_at: startsAt, ends_at: new Date(Date.parse(startsAt) + svc.duration_min * 60_000).toISOString(),
          status: "confirmed", source: "staff", price: svc.price,
        }),
      });
      await page.getByRole("button", { name: en.Booking.submit }).click();
      await expect(page.getByRole("form").getByRole("alert")).toContainText("that time was just booked");
      await expect(page.getByRole("button", { name: en.Booking.pickAnotherTime })).toBeVisible();
    } finally {
      await rest(`appointments?customer_id=eq.${blocker.id}`, { method: "DELETE" });
      await rest(`customers?id=eq.${blocker.id}`, { method: "DELETE" });
    }
  });

  test("ar: RTL form with an inline error has no page-level horizontal overflow", async ({ page }) => {
    await toDetails(page, "ar", 1);
    await details(page, "ar", "اختبار", "123");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByText(ar.Booking.fieldErrors.phone)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
});
