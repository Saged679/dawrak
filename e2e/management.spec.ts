import { expect, test, type Page } from "@playwright/test";
import {
  CLINIC,
  DOCTOR,
  OTHER_DOCTOR,
  SERVICE_KEY,
  SUPABASE_URL,
  createTempTenant,
  clearRateLimits,
  enterDemo,
  loginFixed,
  loginWith,
  rest,
  type TempTenant,
} from "./helpers/tenant";

/**
 * Dashboard phase 2 (services, providers, customers, settings) against the LOCAL Supabase stack.
 * The seeded demo business is read-mostly for demo users (catalogue, hours, time off are locked by the
 * database), so everything that edits the catalogue runs against a TEMPORARY NON-demo business created and
 * removed by the test (helpers/tenant.ts). Demo visitors are used where the demo itself is the subject.
 * The service-role key is only used to inspect, seed and clean up rows, never inside the app under test.
 */
const TZ = "Asia/Riyadh";
const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

const enter = (page: Page, persona: string, locale = "en") => enterDemo(page, persona, locale);

/**
 * Waits until React has hydrated every form and button in <main>. The pages are server-rendered, so
 * on a loaded machine a click can land on the plain HTML before the handlers are attached; a form
 * then submits natively (a GET that reloads the page with the fields in the URL) and no message
 * ever appears. React tags each DOM node it owns with a `__reactProps$...` key, which is a
 * deterministic readiness signal (no sleeps).
 */
async function hydrated(page: Page) {
  await page.waitForFunction(() => {
    const els = [...document.querySelectorAll("main form, main button")];
    return els.length > 0 && els.every((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$")));
  });
}

const link = (p: Page, name: string) => p.getByRole("link", { name, exact: true }).locator("visible=true");
const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.beforeAll(() => {
  test.skip(!SUPABASE_URL || !SERVICE_KEY, "local Supabase env is missing");
});

test.describe("owner manages services and providers; the public page follows", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "chromium", "mutating flows run once");
  });

  const stamp = Date.now().toString(36);
  const providerEn = `E2E Provider ${stamp}`;
  const serviceEn = `E2E Service ${stamp}`;
  let providerId = "";
  let serviceId = "";

  let biz: TempTenant;
  test.beforeAll(async () => {
    test.skip(!SUPABASE_URL || !SERVICE_KEY, "local Supabase env is missing");
    biz = await createTempTenant({ label: "mgmt" });
  });
  test.afterAll(async () => {
    if (biz) await biz.cleanup(); // cascades the services, providers, hours and time off created below
  });

  test("create a provider, set split-shift hours and a day off", async ({ page }) => {
    await loginWith(page, biz.email, biz.password);
    await link(page, "Providers").click();
    await page.getByTestId("provider-new").click();
    await hydrated(page);
    await page.getByLabel("Name (Arabic)").fill("مقدم اختبار");
    await page.getByLabel("Name (English)").fill(providerEn);
    await page.getByTestId("provider-save").click();
    await page.waitForURL(/\/en\/dashboard\/providers\/[0-9a-f-]{36}$/);
    providerId = page.url().split("/").pop()!;
    await hydrated(page);
    await expect(page.getByTestId("provider-title")).toHaveText(providerEn);

    // Every day 10:00-12:00 and 14:00-16:00 (a split shift on Sunday only), tenant timezone.
    for (let d = 0; d < 7; d++) {
      await page.getByTestId(`add-range-${d}`).click();
      await page.getByTestId(`range-${d}-0`).locator("input").nth(0).fill("10:00");
      await page.getByTestId(`range-${d}-0`).locator("input").nth(1).fill("12:00");
    }
    await page.getByTestId("add-range-0").click();
    await page.getByTestId("range-0-1").locator("input").nth(0).fill("14:00");
    await page.getByTestId("range-0-1").locator("input").nth(1).fill("16:00");
    await page.getByTestId("hours-save").click();
    await expect(page.getByTestId("hours-msg")).toHaveText("Working hours saved.");
    const rows = (await rest(`working_hours?provider_id=eq.${providerId}&select=weekday,start_time,end_time`)) as {
      weekday: number;
      start_time: string;
    }[];
    expect(rows).toHaveLength(8);
    expect(rows.filter((r) => r.weekday === 0)).toHaveLength(2);

    // The whole of tomorrow (Riyadh) off.
    const tomorrow = dayKey(new Date(Date.now() + 86_400_000));
    await page.getByLabel("From").fill(`${tomorrow}T00:00`);
    await page.getByLabel("Until").fill(`${tomorrow}T23:59`);
    await page.getByLabel("Reason (optional)").fill("E2E day off");
    await page.getByTestId("time-off-add").click();
    await expect(page.getByTestId("time-off-msg")).toHaveText("Time off added.");
    await expect(page.getByTestId("time-off-list")).toContainText("E2E day off");
    const off = (await rest(`time_off?provider_id=eq.${providerId}&select=starts_at,ends_at`)) as { starts_at: string; ends_at: string }[];
    expect(off).toHaveLength(1);
    // stored as the UTC instant of Riyadh (UTC+3) wall-clock midnight
    expect(new Date(off[0].starts_at).getTime()).toBe(Date.parse(`${tomorrow}T00:00:00Z`) - 3 * 3600_000);
  });

  test("invalid hours are rejected with a message and nothing is saved", async ({ page }) => {
    await loginWith(page, biz.email, biz.password);
    await page.goto(`/en/dashboard/providers/${providerId}`);
    await hydrated(page);
    const before = ((await rest(`working_hours?provider_id=eq.${providerId}&select=id`)) as unknown[]).length;

    // inverted range on Monday (weekday 1)
    await page.getByTestId("range-1-0").locator("input").nth(0).fill("17:00");
    await page.getByTestId("range-1-0").locator("input").nth(1).fill("09:00");
    await page.getByTestId("hours-save").click();
    await expect(page.getByTestId("hours-msg")).toContainText("an end time is not after its start time");
    await expect(page.getByTestId("hours-msg")).toHaveAttribute("role", "alert");

    // overlapping ranges on Tuesday (weekday 2)
    await page.reload();
    await hydrated(page);
    await page.getByTestId("add-range-2").click();
    await page.getByTestId("range-2-1").locator("input").nth(0).fill("11:00");
    await page.getByTestId("range-2-1").locator("input").nth(1).fill("13:00");
    await page.getByTestId("hours-save").click();
    await expect(page.getByTestId("hours-msg")).toContainText("two ranges overlap");

    const after = ((await rest(`working_hours?provider_id=eq.${providerId}&select=id`)) as unknown[]).length;
    expect(after).toBe(before);
  });

  test("create and edit a service linked to that provider", async ({ page }) => {
    await loginWith(page, biz.email, biz.password);
    await link(page, "Services").click();
    await page.getByTestId("service-new").click();
    await hydrated(page);
    await page.getByLabel("Name (Arabic)").fill("خدمة اختبار");
    await page.getByLabel("Name (English)").fill(serviceEn);
    await page.getByLabel("Duration (minutes)").fill("30");
    await page.getByLabel("Buffer after (minutes)").fill("0");
    await page.getByLabel(/^Price/).fill("99");
    await page.getByLabel(providerEn).check();
    await page.getByTestId("service-save").click();
    await page.waitForURL(/\/en\/dashboard\/services\/[0-9a-f-]{36}$/);
    serviceId = page.url().split("/").pop()!;
    await hydrated(page);

    let row = ((await rest(`services?id=eq.${serviceId}&select=name_en,price,duration_min,is_active,tenant_id`)) as Record<string, unknown>[])[0];
    expect(row).toMatchObject({ name_en: serviceEn, price: 99, duration_min: 30, is_active: true, tenant_id: biz.tenantId });
    expect(((await rest(`provider_services?service_id=eq.${serviceId}&select=provider_id`)) as { provider_id: string }[]).map((r) => r.provider_id)).toEqual([providerId]);

    // edit
    await page.getByLabel(/^Price/).fill("120.5");
    // a successful edit ends with router.refresh(); let that re-render land before the next submit
    const refreshed = page.waitForResponse((r) => r.request().method() === "GET" && r.url().includes("_rsc="));
    await page.getByTestId("service-save").click();
    await expect(page.getByTestId("form-msg")).toHaveText("Saved.");
    await refreshed;
    row = ((await rest(`services?id=eq.${serviceId}&select=price`)) as Record<string, unknown>[])[0];
    expect(Number(row.price)).toBe(120.5);

    // server-side validation message for a bad value
    await page.getByLabel(/^Price/).fill("-3");
    await page.getByTestId("service-save").click();
    await expect(page.getByTestId("form-msg")).toContainText("Some fields are not valid");
  });

  test("the public booking page offers the new service only inside the new hours and not on the day off", async ({ page }) => {
    await rest("rate_limits?key=like.*", { method: "DELETE" });
    await page.goto(`/en/c/${biz.slug}`);
    await page.getByText(serviceEn, { exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click(); // service -> provider
    await page.getByText(providerEn).click();
    await page.getByRole("button", { name: "Continue" }).click(); // provider -> time

    const days = page.locator('input[name="day-choice"]');
    await days.first().waitFor({ state: "attached" });
    const tomorrow = dayKey(new Date(Date.now() + 86_400_000));
    await expect(page.locator(`input[name="day-choice"][value="${tomorrow}"]`)).toBeDisabled();

    // pick the first day that has slots; every time must be 10:00-11:30 or Sunday 14:00-15:30
    const open = page.locator('input[name="day-choice"]:not([disabled])').first();
    const openKey = (await open.getAttribute("value"))!;
    await open.check({ force: true });
    const labels = await page.locator('input[name="slot-choice"] + span').allTextContents();
    expect(labels.length).toBeGreaterThan(0);
    const sunday = new Date(`${openKey}T12:00:00Z`).getUTCDay() === 0;
    for (const l of labels) {
      const m = /^(\d{1,2}):(\d{2})\s?(AM|PM)$/i.exec(l.trim());
      expect(m, `slot label "${l}"`).not.toBeNull();
      let h = Number(m![1]) % 12;
      if (/pm/i.test(m![3])) h += 12;
      const minutes = h * 60 + Number(m![2]);
      const inMorning = minutes >= 10 * 60 && minutes <= 11 * 60 + 30;
      const inAfternoon = sunday && minutes >= 14 * 60 && minutes <= 15 * 60 + 30;
      expect(inMorning || inAfternoon, `slot ${l} on ${openKey}`).toBe(true);
    }
  });

  test("deactivated service disappears from the public page; reactivating brings it back", async ({ page }) => {
    await loginWith(page, biz.email, biz.password);
    await page.goto("/en/dashboard/services");
    await hydrated(page);
    const card = page.getByTestId(`service-${serviceId}`);
    await card.getByRole("button", { name: "Deactivate" }).click();
    await expect(card).toHaveAttribute("data-active", "false");
    await expect.poll(async () => ((await rest(`services?id=eq.${serviceId}&select=is_active`)) as { is_active: boolean }[])[0].is_active).toBe(false);
    await page.goto(`/en/c/${biz.slug}`);
    await expect(page.getByText(serviceEn, { exact: true })).toHaveCount(0);
    await page.goto("/en/dashboard/services");
    await hydrated(page);
    await page.getByTestId(`service-${serviceId}`).getByRole("button", { name: "Activate" }).click();
    await expect(page.getByTestId(`service-${serviceId}`)).toHaveAttribute("data-active", "true");
  });

  test("owner removes the time off again", async ({ page }) => {
    await loginWith(page, biz.email, biz.password);
    await page.goto(`/en/dashboard/providers/${providerId}`);
    await hydrated(page);
    await page.getByRole("button", { name: /Remove time off starting/ }).click();
    await expect(page.getByTestId("time-off-msg")).toHaveText("Time off removed.");
    expect(await rest(`time_off?provider_id=eq.${providerId}&select=id`)).toHaveLength(0);
  });
});

test.describe("settings (owner only)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "chromium", "mutating flows run once");
  });

  test("demo business: identity, region and brand are locked, the deposit still saves", async ({ page }) => {
    const before = ((await rest(`tenants?id=eq.${CLINIC}&select=name_ar,name_en,timezone,currency,logo_url,brand_color,deposit_enabled,deposit_type,deposit_value`)) as Record<string, unknown>[])[0];
    try {
      await enter(page, "clinic-owner");
      await link(page, "Settings").click();
      await expect(page.getByTestId("settings-form")).toBeVisible();
      await expect(page.getByTestId("settings-demo-locked")).toBeVisible();
      await hydrated(page);
      for (const label of ["Name (Arabic)", "Name (English)", "Time zone", "Currency", "Logo address"]) {
        await expect(page.getByLabel(label, { exact: true }), label).toBeDisabled();
      }
      await expect(page.getByLabel("Brand colour", { exact: true })).toBeDisabled();
      await expect(page.getByLabel("Pick a brand colour")).toBeDisabled();
      // the deposit stays editable and is saved
      const enable = page.getByLabel("Ask for a deposit when a client books");
      await expect(enable).toBeEnabled();
      await enable.check();
      await page.getByLabel("Deposit type").selectOption("percent");
      await page.getByLabel("Deposit (% of the price)").fill("15");
      await page.getByTestId("settings-save").click();
      await expect(page.getByTestId("form-msg")).toHaveText("Saved.");
      const after = ((await rest(`tenants?id=eq.${CLINIC}&select=name_ar,name_en,timezone,currency,logo_url,brand_color,deposit_enabled,deposit_type,deposit_value`)) as Record<string, unknown>[])[0];
      expect(after).toMatchObject({ deposit_enabled: true, deposit_type: "percent" });
      expect(Number(after.deposit_value)).toBe(15);
      expect({ ...after, deposit_enabled: before.deposit_enabled, deposit_type: before.deposit_type, deposit_value: before.deposit_value }).toEqual(before);
    } finally {
      await rest(`tenants?id=eq.${CLINIC}`, {
        method: "PATCH",
        body: JSON.stringify({ deposit_enabled: before.deposit_enabled, deposit_type: before.deposit_type, deposit_value: before.deposit_value }),
      });
    }
  });

  test.describe("a non-demo business owner can still edit everything", () => {
    let biz: TempTenant;
    let tenantId = "";
    test.beforeAll(async () => {
      biz = await createTempTenant({ label: "settings" });
      tenantId = biz.tenantId;
    });
    test.afterAll(async () => {
      if (biz) await biz.cleanup();
    });

    test("fields are enabled; name, colour and logo are saved; invalid input is refused", async ({ page }) => {
      await clearRateLimits();
      await loginWith(page, biz.email, biz.password, "en", "/dashboard/settings");
      await expect(page.getByTestId("settings-form")).toBeVisible();
      await expect(page.getByTestId("settings-demo-locked")).toHaveCount(0);
      await hydrated(page);
      for (const label of ["Name (Arabic)", "Name (English)", "Time zone", "Currency", "Logo address", "Brand colour"]) {
        await expect(page.getByLabel(label, { exact: true }), label).toBeEnabled();
      }
      // live preview follows the colour
      await page.getByLabel("Brand colour", { exact: true }).fill("#be185d");
      await expect(page.getByTestId("brand-preview")).toHaveCSS("background-color", "rgb(190, 24, 93)");
      // not accepted: logo over plain http; nothing saved
      await page.getByLabel("Logo address").fill("http://example.com/logo.png");
      await page.getByTestId("settings-save").click();
      await expect(page.getByTestId("form-msg")).toContainText("Some fields are not valid");
      expect(((await rest(`tenants?id=eq.${tenantId}&select=brand_color`)) as { brand_color: string | null }[])[0].brand_color).toBeNull();
      // accepted
      const renamed = `E2E Renamed ${biz.slug}`;
      await page.getByLabel("Name (English)", { exact: true }).fill(renamed);
      await page.getByLabel("Logo address").fill("");
      await page.getByTestId("settings-save").click();
      await expect(page.getByTestId("form-msg")).toHaveText("Saved.");
      expect(((await rest(`tenants?id=eq.${tenantId}&select=name_en,brand_color`)) as { name_en: string; brand_color: string }[])[0]).toEqual({ name_en: renamed, brand_color: "#be185d" });
      // the offered time zones are all ones the booking functions can use
      const zones = await page.getByLabel("Time zone").locator("option").allTextContents();
      expect(zones).toContain("Asia/Riyadh");
    });
  });
});

test.describe("role gates by URL", () => {
  test("receptionist can read services but not edit them, and cannot open settings", async ({ page }) => {
    await enter(page, "clinic-reception");
    await expect(link(page, "Services")).toBeVisible();
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
    await page.goto("/en/dashboard/services");
    await expect(page.getByTestId("service-list")).toBeVisible();
    await expect(page.getByTestId("service-new")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Deactivate" })).toHaveCount(0);

    const [svc] = (await rest(`services?tenant_id=eq.${CLINIC}&select=id&limit=1`)) as { id: string }[];
    for (const path of ["/en/dashboard/services/new", `/en/dashboard/services/${svc.id}`, "/en/dashboard/settings", "/en/dashboard/providers/new"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/en\/dashboard$/);
    }
    // providers: read only, no editor controls
    await page.goto(`/en/dashboard/providers/${DOCTOR}`);
    await expect(page.getByTestId("hours-form")).toBeVisible();
    await expect(page.getByTestId("hours-save")).toHaveCount(0);
    await expect(page.getByTestId("provider-save")).toHaveCount(0);
    await expect(page.getByTestId("time-off-add")).toHaveCount(0);
  });

  test.describe("doctor", () => {
    test.describe.configure({ mode: "serial" });
    let customerId = "";
    let appointmentId = "";
    let ownCustomerId = "";
    // This block runs once per project, in parallel, so each project seeds its own rows: the same
    // fixed slot for OTHER_DOCTOR would trip the no-overlap constraint and one project's afterAll
    // would delete the other's patient.
    const project = () => test.info().project.name;
    let patientName = "";

    test.beforeAll(async () => {
      test.skip(!SUPABASE_URL || !SERVICE_KEY, "local Supabase env is missing");
      const [svc] = (await rest(`services?tenant_id=eq.${CLINIC}&select=id,duration_min,price&limit=1`)) as { id: string; duration_min: number; price: number }[];
      const hour = project() === "chromium" ? "08" : "10";
      patientName = `E2E Other Patient ${project()}`;
      const [c] = (await rest("customers", {
        method: "POST",
        body: JSON.stringify({ tenant_id: CLINIC, full_name: patientName, phone: `+9665${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`, email: "e2e-other@example.com" }),
      })) as { id: string }[];
      customerId = c.id;
      const [a] = (await rest("appointments", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: CLINIC,
          provider_id: OTHER_DOCTOR,
          service_id: svc.id,
          customer_id: customerId,
          starts_at: `2027-03-01T${hour}:00:00Z`,
          ends_at: `2027-03-01T${hour}:30:00Z`,
          status: "completed",
          source: "staff",
          price: svc.price,
        }),
      })) as { id: string }[];
      appointmentId = a.id;
      // a customer who does have an appointment with DOCTOR
      const own = (await rest(`appointments?tenant_id=eq.${CLINIC}&provider_id=eq.${DOCTOR}&select=customer_id&limit=1`)) as { customer_id: string }[];
      ownCustomerId = own[0].customer_id;
    });

    test.afterAll(async () => {
      if (appointmentId) await rest(`appointments?id=eq.${appointmentId}`, { method: "DELETE" });
      if (customerId) await rest(`customers?id=eq.${customerId}`, { method: "DELETE" });
    });

    test("is limited to own customers, own schedule, and no settings or services, even by URL", async ({ page }) => {
      await loginFixed(page, "clinic-doctor");
      await expect(link(page, "My schedule")).toBeVisible();
      await expect(link(page, "Customers")).toBeVisible();
      for (const name of ["Settings", "Services", "Revenue", "Providers"]) {
        await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
      }
      for (const path of ["/en/dashboard/settings", "/en/dashboard/services", "/en/dashboard/services/new", "/en/dashboard/providers/new"]) {
        await page.goto(path);
        await expect(page).toHaveURL(/\/en\/dashboard$/);
      }
      // another provider's page sends them back to their own
      await page.goto(`/en/dashboard/providers/${OTHER_DOCTOR}`);
      await expect(page).toHaveURL(new RegExp(`/en/dashboard/providers/${DOCTOR}$`));
      await page.goto("/en/dashboard/providers");
      await expect(page).toHaveURL(new RegExp(`/en/dashboard/providers/${DOCTOR}$`));
      await expect(page.getByTestId("hours-form")).toBeVisible();
      await expect(page.getByTestId("hours-save")).toHaveCount(0);
      await expect(page.getByTestId("time-off-add")).toHaveCount(0);

      // customers: the other doctor's patient is neither listed, searchable nor openable
      await page.goto("/en/dashboard/customers");
      await expect(page.getByTestId("customer-list")).toBeVisible();
      await expect(page.getByTestId(`customer-${ownCustomerId}`)).toBeVisible();
      await expect(page.getByTestId(`customer-${customerId}`)).toHaveCount(0);
      await page.goto("/en/dashboard/customers?q=E2E%20Other");
      await expect(page.getByTestId("customers-empty")).toBeVisible();
      await page.goto(`/en/dashboard/customers/${customerId}`);
      await expect(page).toHaveURL(/\/en\/dashboard\/customers$/);
      await page.goto(`/en/dashboard/customers/${ownCustomerId}`);
      await expect(page.getByTestId("customer-name")).toBeVisible();
      // history is limited to this doctor's own appointments
      const mine = (await rest(`appointments?tenant_id=eq.${CLINIC}&provider_id=eq.${DOCTOR}&customer_id=eq.${ownCustomerId}&select=id`)) as unknown[];
      await expect(page.getByTestId("customer-history").locator("li")).toHaveCount(mine.length);
    });

    test("owner finds the customer by search, sees history and never the access token", async ({ page }) => {
      await enter(page, "clinic-owner");
      await link(page, "Customers").click();
      await page.getByTestId("customer-search").fill(patientName);
      await page.getByRole("button", { name: "Search" }).click();
      await expect(page.getByTestId(`customer-${customerId}`)).toBeVisible();
      await expect(page.getByTestId(`customer-${customerId}`)).toContainText(patientName);
      await page.getByTestId(`customer-${customerId}`).click();
      await expect(page.getByTestId("customer-name")).toHaveText(patientName);
      await expect(page.getByTestId("customer-history").locator("li")).toHaveCount(1);
      const [secret] = (await rest(`customers?id=eq.${customerId}&select=access_token`)) as { access_token: string }[];
      expect(await page.content()).not.toContain(secret.access_token);
      expect(await page.content()).not.toContain("access_token");
      await page.goto("/en/dashboard/customers?q=zzzz-no-such-person");
      await expect(page.getByTestId("customers-empty")).toBeVisible();
      // special characters in the search box do not break the query
      await page.goto(`/en/dashboard/customers?q=${encodeURIComponent("a,b)(%_*\"")}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Customers");
    });
  });
});

test.describe("Hijri date and reduced motion", () => {
  test("English calendar header has no Arabic script in the Hijri line; Arabic still does", async ({ page }, info) => {
    test.skip(info.project.name !== "chromium", "runs once");
    await enter(page, "clinic-owner", "en");
    await page.goto("/en/dashboard/calendar?view=day");
    const en = (await page.getByTestId("cal-hijri").textContent()) ?? "";
    expect(en).toMatch(/^Hijri: /);
    expect(en).not.toMatch(/[؀-ۿ]/);
    expect(en).toMatch(/AH/);
    await page.goto("/en/dashboard/calendar?view=week");
    expect(((await page.getByTestId("cal-hijri").textContent()) ?? "")).not.toMatch(/[؀-ۿ]/);
    await page.goto("/ar/dashboard/calendar?view=day");
    expect(((await page.getByTestId("cal-hijri").textContent()) ?? "")).toMatch(/[؀-ۿ]/);
  });

  test("prefers-reduced-motion disables transitions", async ({ page }, info) => {
    test.skip(info.project.name !== "chromium", "runs once");
    await enter(page, "clinic-owner", "en");
    const duration = () =>
      page.evaluate(() => {
        const el = document.querySelector("summary svg") as Element;
        return getComputedStyle(el).transitionDuration;
      });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(parseFloat(await duration())).toBeGreaterThan(0.05); // the chevron really animates...
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(parseFloat(await duration())).toBeLessThan(0.001); // ...and the global rule stops it
  });
});

test.describe("layout of the new pages at phone and desktop widths", () => {
  for (const locale of ["ar", "en"] as const) {
    for (const width of [360, 1280]) {
      test(`${locale} @ ${width}px: no page-level horizontal overflow`, async ({ page }, info) => {
        test.skip(info.project.name !== "chromium", "explicit viewport used instead of the device profile");
        await page.setViewportSize({ width, height: 800 });
        await enter(page, "clinic-owner", locale);
        const [cust] = (await rest(`customers?tenant_id=eq.${CLINIC}&select=id&limit=1`)) as { id: string }[];
        const [svc] = (await rest(`services?tenant_id=eq.${CLINIC}&select=id&limit=1`)) as { id: string }[];
        const paths = [
          "services",
          "services/new",
          `services/${svc.id}`,
          "providers",
          "providers/new",
          `providers/${DOCTOR}`,
          "customers",
          `customers/${cust.id}`,
          "settings",
        ];
        for (const p of paths) {
          await page.goto(`/${locale}/dashboard/${p}`);
          await expect(page.locator("main h1").first()).toBeVisible();
          expect(await noOverflow(page), `${locale} ${width} ${p}`).toBeLessThanOrEqual(0);
          await page.screenshot({ path: `test-results/shots/${locale}-${width}-${p.replace(/[/-]/g, "_").slice(0, 24)}.png`, fullPage: true });
        }
      });
    }
  }
});
