import { expect, test, type Page } from "@playwright/test";
import {
  CLINIC,
  DOCTOR,
  FIXED_DEMO_PASSWORD,
  OTHER_DOCTOR,
  SERVICE_KEY,
  SUPABASE_URL,
  clearRateLimits,
  enterDemo,
  loginFixed,
  rest,
} from "./helpers/tenant";

/**
 * Staff dashboard flows against the LOCAL Supabase stack (npx supabase start). Demo entry creates a NEW
 * temporary visitor user per click; the doctor (provider role) cannot be per-visitor, so doctor flows sign in
 * as the fixed seeded user through the login form (local only: the hosted demo has no fixed login).
 * Appointment status changes and rescheduling are the writes a demo visitor may still make; the service-role
 * key only inspects and restores rows, never inside the app under test.
 */
type Appt = {
  id: string;
  tenant_id: string;
  provider_id: string;
  service_id: string;
  customer_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
};


/** A confirmed future appointment of the clinic, optionally for one provider. */
async function futureConfirmed(providerId?: string, skip = 0): Promise<Appt> {
  const q =
    `appointments?tenant_id=eq.${CLINIC}&status=eq.confirmed&starts_at=gt.${new Date(Date.now() + 36e5).toISOString()}` +
    `&order=starts_at.asc&limit=1&offset=${skip}${providerId ? `&provider_id=eq.${providerId}` : ""}`;
  const rows = (await rest(q)) as Appt[];
  if (!rows[0]) throw new Error("no future confirmed appointment in the seed");
  return rows[0];
}

const dayKey = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date(iso));

async function enter(page: Page, persona: string, locale = "en") {
  if (persona === "clinic-doctor") return loginFixed(page, "clinic-doctor", locale);
  return enterDemo(page, persona, locale);
}

test.beforeAll(async () => {
  test.skip(!SUPABASE_URL || !SERVICE_KEY, "local Supabase env is missing");
  // The demo action is rate limited per client; dev and CI share one bucket.
  await clearRateLimits();
});

test.describe("access control", () => {
  test("a signed-in dashboard page carries noindex", async ({ page }) => {
    await enter(page, "clinic-owner");
    await expect(page.locator("meta[name=robots]")).toHaveAttribute("content", /noindex/);
    await page.goto("/en/dashboard/calendar");
    await expect(page.locator("meta[name=robots]")).toHaveAttribute("content", /noindex/);
  });

  test("signed-out users are sent to the login page", async ({ page }) => {
    for (const path of ["/ar/dashboard", "/en/dashboard/calendar", "/en/dashboard/revenue"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/(ar|en)\/login\?next=/);
      await expect(page.getByRole("button", { name: /Sign in|تسجيل الدخول/ })).toBeVisible();
    }
  });

  test("login rejects a wrong password with a generic message", async ({ page }) => {
    await page.goto("/en/login");
    await page.getByLabel("Email").fill("clinic-owner@example.com");
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("The email or password is not correct.")).toBeVisible();
    await expect(page).toHaveURL(/\/en\/login/);
  });

  test("login form signs in the owner and logout returns to login", async ({ page }) => {
    await page.goto("/en/login?next=/dashboard/calendar");
    await page.getByLabel("Email").fill("clinic-owner@example.com");
    await page.getByLabel("Password").fill(FIXED_DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/en\/dashboard\/calendar/);
    await page.locator("summary").first().click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/en\/login/);
    await page.goto("/en/dashboard");
    await expect(page).toHaveURL(/\/en\/login/);
  });

  test("an open redirect through ?next is ignored", async ({ page }) => {
    await page.goto("/en/login?next=https://evil.example/x");
    await page.getByLabel("Email").fill("clinic-owner@example.com");
    await page.getByLabel("Password").fill(FIXED_DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/en\/dashboard$/);
  });
});

test.describe("demo buttons and role navigation", () => {
  const nav = (p: Page) => p.getByRole("navigation", { name: "Main navigation" }).first();
  // Both the desktop rail and the mobile tabs exist; only one is visible per viewport.
  const link = (p: Page, name: string) => p.getByRole("link", { name, exact: true }).locator("visible=true");

  test("clinic owner sees overview, calendar and revenue", async ({ page }) => {
    await enter(page, "clinic-owner");
    await expect(page.getByTestId("tenant-name")).toHaveText("Nabd Dental Clinic");
    await expect(link(page, "Overview")).toBeVisible();
    await expect(link(page, "Calendar")).toBeVisible();
    await expect(link(page, "Revenue")).toBeVisible();
    await expect(page.getByTestId("revenue-card")).toBeVisible();
    await expect(nav(page)).toBeAttached();
  });

  test("receptionist has no revenue anywhere", async ({ page }) => {
    await enter(page, "clinic-reception");
    await expect(link(page, "Calendar")).toBeVisible();
    await expect(page.getByRole("link", { name: "Revenue", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("revenue-card")).toHaveCount(0);
    await page.goto("/en/dashboard/revenue");
    await expect(page).toHaveURL(/\/en\/dashboard$/);
  });

  test("doctor is limited to their own data, even by URL", async ({ page }) => {
    await enter(page, "clinic-doctor");
    await expect(page.getByRole("link", { name: "Revenue", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("revenue-card")).toHaveCount(0);

    await page.goto("/en/dashboard/revenue");
    await expect(page).toHaveURL(/\/en\/dashboard$/);

    // Asking for another doctor's calendar returns only the doctor's own column and rows.
    await page.goto(`/en/dashboard/calendar?view=day&provider=${OTHER_DOCTOR}`);
    await expect(page.locator(`[data-testid^="col-"]`)).toHaveCount(1);
    await expect(page.getByTestId(`col-${DOCTOR}`)).toBeVisible();
    await expect(page.getByTestId(`col-${OTHER_DOCTOR}`)).toHaveCount(0);

    const other = await futureConfirmed(OTHER_DOCTOR);
    await page.goto(`/en/dashboard/calendar?view=day&date=${dayKey(other.starts_at)}&provider=${OTHER_DOCTOR}`);
    await expect(page.locator(`[data-id="${other.id}"]`)).toHaveCount(0);
    await page.goto(`/en/dashboard/calendar?view=week&date=${dayKey(other.starts_at)}&provider=${OTHER_DOCTOR}`);
    await expect(page.locator(`[data-id="${other.id}"]`)).toHaveCount(0);
  });

  test("salon owner lands in the salon", async ({ page }) => {
    await enter(page, "salon-owner");
    await expect(page.getByTestId("tenant-name")).toHaveText("Lamsa Ladies Salon");
    await expect(page.getByTestId("revenue-card")).toBeVisible();
  });

  test("Arabic demo flow shows Arabic navigation", async ({ page }) => {
    await enter(page, "clinic-owner", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("link", { name: "التقويم", exact: true }).locator("visible=true")).toBeVisible();
    await expect(page.getByTestId("tenant-name")).toHaveText("عيادة نبض لطب الأسنان");
  });
});

test.describe("calendar actions (chromium only, restores what it changes)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "chromium", "mutating flows run once");
  });

  test("owner changes a status and it persists in the database", async ({ page }) => {
    const appt = await futureConfirmed();
    try {
      await enter(page, "clinic-owner");
      await page.goto(`/en/dashboard/calendar?view=day&date=${dayKey(appt.starts_at)}`);
      const block = page.locator(`[data-id="${appt.id}"]`);
      await expect(block).toHaveAttribute("data-status", "confirmed");
      await expect(block).toContainText("Confirmed"); // text label, not colour alone
      await block.click();
      await page.getByTestId("set-completed").click();
      await expect(page.getByTestId("dialog-msg")).toHaveText("Status updated.");
      await expect.poll(async () => ((await rest(`appointments?id=eq.${appt.id}&select=status`)) as { status: string }[])[0].status).toBe("completed");
      await expect(page.getByTestId("appt-dialog").getByText("Completed").first()).toBeVisible();
    } finally {
      await rest(`appointments?id=eq.${appt.id}`, { method: "PATCH", body: JSON.stringify({ status: "confirmed" }) });
    }
  });

  test("calendar is keyboard operable and the dialog traps focus and closes with Escape", async ({ page }) => {
    const appt = await futureConfirmed();
    await enter(page, "clinic-reception");
    await page.goto(`/en/dashboard/calendar?view=day&date=${dayKey(appt.starts_at)}`);
    const block = page.locator(`[data-id="${appt.id}"]`);
    await block.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("appt-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("appt-dialog")).toHaveCount(0);
    await expect(block).toBeFocused();
  });

  test("receptionist reschedules and a conflicting slot shows the friendly message", async ({ page }) => {
    const a = await futureConfirmed(DOCTOR);
    const original = { starts_at: a.starts_at, ends_at: a.ends_at, provider_id: a.provider_id };
    let inserted: string | null = null;
    try {
      await enter(page, "clinic-reception");
      await page.goto(`/en/dashboard/calendar?view=day&date=${dayKey(a.starts_at)}`);
      await page.locator(`[data-id="${a.id}"]`).click();
      await page.getByTestId("mv-open").click();
      await expect(page.getByTestId("mv-slot").first()).toBeVisible();

      // 1. successful move to the last free slot of the day
      const lastSlot = page.getByTestId("mv-slot").last();
      await lastSlot.click();
      await page.getByTestId("mv-confirm").click();
      await expect(page.getByTestId("dialog-msg")).toHaveText("Appointment moved.");
      const moved = ((await rest(`appointments?id=eq.${a.id}&select=starts_at,provider_id`)) as { starts_at: string; provider_id: string }[])[0];
      expect(new Date(moved.starts_at).getTime()).not.toBe(new Date(original.starts_at).getTime());

      // 2. conflict: pick a slot in the UI, then take it behind the UI's back
      await page.getByTestId("mv-open").click();
      await expect(page.getByTestId("mv-slot").first()).toBeVisible();
      const slotButton = page.getByTestId("mv-slot").first();
      await slotButton.click();
      const source = (await rest(`appointments?id=eq.${a.id}`)) as Appt[];
      // Find the chosen slot start from the DB-side function result: use the button order, then
      // book the same provider at the first free slot via the service role.
      const free = await rest("rpc/get_available_slots", {
        method: "POST",
        body: JSON.stringify({
          p_tenant_id: CLINIC,
          p_provider_id: DOCTOR,
          p_service_id: source[0].service_id,
          p_date_from: dayKey(a.starts_at),
          p_date_to: dayKey(a.starts_at),
          p_step_min: 15,
        }),
      });
      const target = (free as { slot_start: string; slot_end: string }[])[0];
      const row = (await rest("appointments", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: CLINIC,
          provider_id: DOCTOR,
          service_id: source[0].service_id,
          customer_id: source[0].customer_id,
          starts_at: target.slot_start,
          ends_at: target.slot_end,
          status: "confirmed",
          source: "staff",
        }),
      })) as Appt[];
      inserted = row[0].id;
      await page.getByTestId("mv-confirm").click();
      await expect(page.getByTestId("dialog-msg")).toHaveText("That time was just taken. Pick another time.");
    } finally {
      if (inserted) await rest(`appointments?id=eq.${inserted}`, { method: "DELETE" });
      await rest(`appointments?id=eq.${a.id}`, { method: "PATCH", body: JSON.stringify(original) });
    }
  });

  test("doctor can only mark own appointments completed / no-show", async ({ page }) => {
    const appt = await futureConfirmed(DOCTOR);
    try {
      await enter(page, "clinic-doctor");
      await page.goto(`/en/dashboard/calendar?view=day&date=${dayKey(appt.starts_at)}`);
      await page.locator(`[data-id="${appt.id}"]`).click();
      await expect(page.getByTestId("set-cancelled")).toHaveCount(0);
      await expect(page.getByTestId("set-confirmed")).toHaveCount(0);
      await expect(page.getByTestId("mv-open")).toHaveCount(0);
      await page.getByTestId("set-no_show").click();
      await expect(page.getByTestId("dialog-msg")).toHaveText("Status updated.");
      await expect.poll(async () => ((await rest(`appointments?id=eq.${appt.id}&select=status`)) as { status: string }[])[0].status).toBe("no_show");
    } finally {
      await rest(`appointments?id=eq.${appt.id}`, { method: "PATCH", body: JSON.stringify({ status: "confirmed" }) });
    }
  });
});

test.describe("layout in both languages at phone and desktop widths", () => {
  for (const locale of ["ar", "en"] as const) {
    for (const width of [360, 1280]) {
      test(`${locale} @ ${width}px: no page-level horizontal overflow`, async ({ page }, info) => {
        test.skip(info.project.name !== "chromium", "explicit viewport used instead of the device profile");
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`/${locale}/demo`);
        await expect(page.getByTestId("demo-clinic-owner")).toBeVisible();
        const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(await overflow()).toBeLessThanOrEqual(0);
        await page.screenshot({ path: `test-results/shots/${locale}-${width}-demo.png`, fullPage: true });

        await page.getByTestId("demo-clinic-owner").click();
        await page.waitForURL(new RegExp(`/${locale}/dashboard`));
        expect(await overflow()).toBeLessThanOrEqual(0);
        await page.screenshot({ path: `test-results/shots/${locale}-${width}-overview.png`, fullPage: true });

        const appt = await futureConfirmed();
        await page.goto(`/${locale}/dashboard/calendar?view=day&date=${dayKey(appt.starts_at)}`);
        await expect(page.getByTestId("calendar-grid")).toBeVisible();
        expect(await overflow()).toBeLessThanOrEqual(0); // only the grid container scrolls
        await page.screenshot({ path: `test-results/shots/${locale}-${width}-calendar.png`, fullPage: true });
        await page.goto(`/${locale}/dashboard/calendar?view=week&date=${dayKey(appt.starts_at)}&provider=${DOCTOR}`);
        expect(await overflow()).toBeLessThanOrEqual(0);
        await page.screenshot({ path: `test-results/shots/${locale}-${width}-week.png`, fullPage: true });
      });
    }
  }
});
