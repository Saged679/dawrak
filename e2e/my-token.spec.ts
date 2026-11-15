import { expect, test } from "@playwright/test";
import ar from "../messages/ar.json";
import { clearRateLimits, createTempTenant, hasLocalDb, rest, type TempTenant } from "./helpers/tenant";

/**
 * The patient page /[locale]/c/[slug]/my/[token] opened directly with a customer token (no booking flow):
 * view, cancel inside the 2 hour window, cancel outside it (too_late), reschedule, in en and ar, desktop and phone.
 * Rows are seeded with the service role on the demo salon and removed afterwards.
 */
const created: string[] = [];
const phone8 = () => Math.floor(Math.random() * 1e8).toString().padStart(8, "0");

let biz: TempTenant;
let tenantId = "";
let serviceId = "";
async function seed(startsInMs: number, locale: "ar" | "en" = "en", jitterMin = 600) {
  const tenant = { id: tenantId };
  const service = { id: serviceId, price: 120 };
  // a fresh provider per appointment: parallel tests (and both projects) can never collide on one provider's time
  const [provider] = (await rest("providers", { method: "POST", body: JSON.stringify({ tenant_id: tenantId, name_ar: "مقدمة", name_en: "My Provider" }) })) as { id: string }[];
  await rest("provider_services", { method: "POST", body: JSON.stringify({ tenant_id: tenantId, provider_id: provider.id, service_id: serviceId }) });
  await rest("working_hours", { method: "POST", body: JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((d) => ({ tenant_id: tenantId, provider_id: provider.id, weekday: d, start_time: "00:00", end_time: "23:59" }))) });
  const [customer] = (await rest("customers", {
    method: "POST",
    body: JSON.stringify({ tenant_id: tenant.id, full_name: "Portal Tester", phone: `+9665${phone8()}`, email: "portal@example.com", locale }),
  })) as { id: string }[];
  created.push(customer.id);
  let appt: { id: string; starts_at: string } | undefined;
  for (let i = 0; i < 8 && !appt; i++) {
    // jitter by whole minutes so parallel projects never share a slot
    const start = new Date(Date.now() + startsInMs + Math.floor(Math.random() * jitterMin) * 60_000);
    try {
      [appt] = (await rest("appointments", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: tenant.id, provider_id: provider.id, service_id: service.id, customer_id: customer.id,
          starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 1_800_000).toISOString(),
          status: "confirmed", source: "web", price: service.price,
        }),
      })) as { id: string; starts_at: string }[];
    } catch (e) {
      if (!String(e).includes("23P01")) throw e;
    }
  }
  if (!appt) throw new Error("could not place a seed appointment");
  const [{ access_token }] = (await rest(`customers?id=eq.${customer.id}&select=access_token`)) as { access_token: string }[];
  return { token: access_token, appointmentId: appt.id, customerId: customer.id };
}
const status = async (id: string) => ((await rest(`appointments?id=eq.${id}&select=status`)) as { status: string }[])[0].status;
const DAY = 86_400_000;
/** Moves the appointment to start within the 2 h window (retries on the no-overlap constraint). */
async function moveSoon(id: string) {
  for (let i = 0; i < 20; i++) {
    const start = new Date(Date.now() + (10 + Math.floor(Math.random() * 100)) * 60_000);
    try {
      await rest(`appointments?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 1_200_000).toISOString() }) });
      return;
    } catch (e) {
      if (!String(e).includes("23P01")) throw e;
    }
  }
  throw new Error("no free soon slot");
}

test.describe("patient page by token", () => {
  test.skip(!hasLocalDb(), "needs the local Supabase stack");
  test.beforeEach(async () => {
    await clearRateLimits();
  });
  test.beforeAll(async () => {
    // a temporary NON-demo business: nothing seeded can collide with appointments that start within 2 hours
    biz = await createTempTenant({ kind: "salon", label: "my" });
    tenantId = biz.tenantId;
    const [svc] = (await rest("services", { method: "POST", body: JSON.stringify({ tenant_id: tenantId, name_ar: "قص", name_en: "My Cut", duration_min: 30, price: 120 }) })) as { id: string }[];
    serviceId = svc.id;
  });
  test.afterAll(async () => {
    if (biz) await biz.cleanup(); // cascades every row created above
  });

  test("view (en): appointment, status, privacy headers, no staff data", async ({ page }) => {
    const s = await seed(5 * DAY);
    const res = await page.goto(`/en/c/${biz.slug}/my/${s.token}`);
    expect(res?.status()).toBe(200);
    expect(res?.headers()["referrer-policy"]).toBe("no-referrer");
    expect(res?.headers()["cache-control"]).toContain("no-store");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.getByTestId("portal-appointment")).toHaveCount(1);
    await expect(page.getByTestId("portal-status")).toHaveText("Confirmed");
    await expect(page.getByTestId("reschedule-link")).toBeVisible();
    expect(await page.content()).not.toContain(s.customerId);
  });

  test("view (ar): Arabic status, RTL, no page-level overflow", async ({ page }) => {
    const s = await seed(5 * DAY, "ar");
    await page.goto(`/ar/c/${biz.slug}/my/${s.token}`);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("portal-status")).toHaveText(ar.Portal.status.confirmed);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });

  test("cancel well inside the window works and is final (en)", async ({ page }) => {
    const s = await seed(3 * DAY);
    await page.goto(`/en/c/${biz.slug}/my/${s.token}`);
    await page.getByText("Cancel this appointment", { exact: true }).click();
    await expect(page.getByText("Cancelling is possible up to 2 hours before the start.")).toBeVisible();
    await page.getByTestId("cancel-confirm").click();
    await expect(page.getByTestId("portal-done")).toContainText("cancelled");
    expect(await status(s.appointmentId)).toBe("cancelled");
    await expect(page.getByTestId("reschedule-link")).toHaveCount(0);
  });

  test("cancel (ar): the confirmation names the 2 hour window in Arabic ({hours} placeholder)", async ({ page }) => {
    const s = await seed(3 * DAY, "ar");
    await page.goto(`/ar/c/${biz.slug}/my/${s.token}`);
    await page.getByText(ar.Portal.cancel, { exact: true }).click();
    await expect(page.getByText("حتى ساعتين قبل البداية")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("{hours}");
    await page.getByTestId("cancel-confirm").click();
    await expect(page.getByTestId("portal-done")).toContainText(ar.Portal.doneCancelled);
    expect(await status(s.appointmentId)).toBe("cancelled");
  });

  test("an appointment starting in under 2 hours shows the too-late note and no controls (en)", async ({ page }) => {
    const s = await seed(60 * 60_000, "en", 50);
    await page.goto(`/en/c/${biz.slug}/my/${s.token}`);
    await expect(page.getByTestId("portal-appointment")).toContainText("starts in less than 2 hours");
    await expect(page.getByTestId("reschedule-link")).toHaveCount(0);
    await expect(page.getByTestId("cancel-confirm")).toHaveCount(0);
    expect(await status(s.appointmentId)).toBe("confirmed");
  });

  test("an appointment starting in under 2 hours shows the too-late note in Arabic", async ({ page }) => {
    const s = await seed(60 * 60_000, "ar", 50);
    await page.goto(`/ar/c/${biz.slug}/my/${s.token}`);
    await expect(page.getByTestId("portal-appointment")).toContainText("أقل من ساعتين");
    await expect(page.getByTestId("cancel-confirm")).toHaveCount(0);
  });

  test("the window closes while the page is open: submitting cancel is refused with the too-late error and nothing changes", async ({ page }) => {
    const s = await seed(3 * DAY);
    await page.goto(`/en/c/${biz.slug}/my/${s.token}`);
    await page.getByText("Cancel this appointment", { exact: true }).click();
    // time passes: the appointment is now 30 minutes away
    await moveSoon(s.appointmentId);
    await page.getByTestId("cancel-confirm").click();
    await expect(page.getByTestId("portal-error")).toContainText("up to 2 hours before they start");
    expect(await status(s.appointmentId)).toBe("confirmed");
  });

  test("the too-late error is worded in Arabic with the real hour count", async ({ page }) => {
    const s = await seed(3 * DAY, "ar");
    await page.goto(`/ar/c/${biz.slug}/my/${s.token}`);
    await page.getByText(ar.Portal.cancel, { exact: true }).click();
    await moveSoon(s.appointmentId);
    await page.getByTestId("cancel-confirm").click();
    await expect(page.getByTestId("portal-error")).toContainText("حتى ساعتين قبل بدايته");
    expect(await status(s.appointmentId)).toBe("confirmed");
  });

  test("reschedule to a new time (en) moves the appointment and reaches the done state", async ({ page }) => {
    const s = await seed(3 * DAY);
    const before = ((await rest(`appointments?id=eq.${s.appointmentId}&select=starts_at`)) as { starts_at: string }[])[0].starts_at;
    await page.goto(`/en/c/${biz.slug}/my/${s.token}`);
    await page.getByTestId("reschedule-link").click();
    await expect(page.getByTestId("reschedule-panel")).toBeVisible();
    await page.getByTestId("reschedule-panel").getByRole("navigation").getByRole("link").last().click();
    await page.waitForURL(/day=\d{4}-\d{2}-\d{2}/);
    const slot = page.locator('input[name="startsAt"]').last();
    const value = await slot.getAttribute("value");
    await slot.check({ force: true });
    await page.getByTestId("reschedule-confirm").click();
    await expect(page.getByTestId("portal-done")).toContainText("moved to the new time");
    const after = ((await rest(`appointments?id=eq.${s.appointmentId}&select=starts_at`)) as { starts_at: string }[])[0].starts_at;
    expect(new Date(after).getTime()).toBe(new Date(value!).getTime());
    expect(after).not.toBe(before);
  });

  test("reschedule without picking a time sends the patient back with the pick-a-time message (ar)", async ({ page }) => {
    const s = await seed(3 * DAY, "ar");
    await page.goto(`/ar/c/${biz.slug}/my/${s.token}?reschedule=${s.appointmentId}`);
    await expect(page.getByTestId("reschedule-panel")).toBeVisible();
    // radios are `required`, so a native submit is blocked; remove it to send the form without a time
    await page.locator('input[name="startsAt"]').evaluateAll((els) => els.forEach((e) => e.removeAttribute("required")));
    await page.getByTestId("reschedule-confirm").click();
    await expect(page.getByTestId("portal-error")).toContainText(ar.Portal.errors.pick_time);
  });

  test("a cancelled appointment cannot be cancelled again and stays in the past list", async ({ page }) => {
    const s = await seed(3 * DAY);
    await rest(`appointments?id=eq.${s.appointmentId}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled", cancel_reason: "customer" }) });
    await page.goto(`/en/c/${biz.slug}/my/${s.token}`);
    await expect(page.getByTestId("portal-status")).toHaveText("Cancelled");
    await expect(page.getByTestId("cancel-confirm")).toHaveCount(0);
    await expect(page.getByTestId("reschedule-link")).toHaveCount(0);
  });
});
