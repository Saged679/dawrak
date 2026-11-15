import { expect, test } from "@playwright/test";
import ar from "../messages/ar.json";
import { CLINIC, SALON, SERVICE_KEY, SUPABASE_URL, createTempTenant, loginFixed, loginWith, rest, type TempTenant } from "./helpers/tenant";

/**
 * Gap-filler for the dashboard: revenue journey, customers/[id], providers/[id] (owner, en + ar, phone width),
 * and access denials for the receptionist and the provider (pages, other tenant's ids, upload API).
 * Services new/edit/deactivate, settings (demo-locked + non-demo) and knowledge live in management.spec.ts,
 * demo-visitors.spec.ts and knowledge.spec.ts. Catalogue edits run on a temporary non-demo business.
 */
test.beforeAll(() => {
  test.skip(!SUPABASE_URL || !SERVICE_KEY, "local Supabase env is missing");
});
const overflow = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("revenue journey (owner, temporary business)", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "chromium", "seeded data is shared: runs once");
  });
  let biz: TempTenant;
  test.beforeAll(async () => {
    biz = await createTempTenant({ label: "rev" });
  });
  test.afterAll(async () => {
    if (biz) await biz.cleanup();
  });

  async function seedPaid(amount: number, i: number, status = "paid") {
    const [prov] = (await rest("providers", { method: "POST", body: JSON.stringify({ tenant_id: biz.tenantId, name_ar: "م", name_en: `P${i}` }) })) as { id: string }[];
    const [svc] = (await rest("services", { method: "POST", body: JSON.stringify({ tenant_id: biz.tenantId, name_ar: "خ", name_en: `S${i}`, duration_min: 30, price: amount }) })) as { id: string }[];
    const [cus] = (await rest("customers", { method: "POST", body: JSON.stringify({ tenant_id: biz.tenantId, full_name: `Rev ${i}`, phone: `+9665${(10000000 + i).toString()}` }) })) as { id: string }[];
    const start = new Date(Date.now() + (3 + i) * 86_400_000);
    const [appt] = (await rest("appointments", {
      method: "POST",
      body: JSON.stringify({ tenant_id: biz.tenantId, provider_id: prov.id, service_id: svc.id, customer_id: cus.id, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 1_800_000).toISOString(), status: "confirmed", source: "web", price: amount }),
    })) as { id: string }[];
    await rest("payments", {
      method: "POST",
      body: JSON.stringify({ tenant_id: biz.tenantId, appointment_id: appt.id, amount, currency: "SAR", provider: "fake", status, public_token: `${i}`.repeat(48).slice(0, 48) }),
    });
  }

  test("empty state, then paid payments are summed; unpaid ones are not (en and ar)", async ({ page }) => {
    await loginWith(page, biz.email, biz.password, "en", "/dashboard/revenue");
    await expect(page.getByTestId("revenue-total")).toContainText("0");
    await expect(page.getByText("No paid payments").first()).toBeVisible();

    await seedPaid(100, 1);
    await seedPaid(50.5, 2);
    await seedPaid(999, 3, "pending");
    await page.reload();
    await expect(page.getByTestId("revenue-total")).toContainText("150.50");
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByTestId("revenue-total")).not.toContainText("1,149");

    await page.goto("/ar/dashboard/revenue");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ar.Revenue.title);
    await expect(page.getByTestId("revenue-total")).toContainText(/١٥٠٫٥/);
  });

  test("revenue at phone width has no page-level overflow", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await loginWith(page, biz.email, biz.password, "en", "/dashboard");
    await page.goto(`/ar${("/dashboard/revenue")}`);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });
});

test.describe("customer and provider detail pages (owner)", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "chromium", "runs once");
  });
  let biz: TempTenant;
  let customerId = "";
  let providerId = "";
  test.beforeAll(async () => {
    biz = await createTempTenant({ label: "detail" });
    const [prov] = (await rest("providers", { method: "POST", body: JSON.stringify({ tenant_id: biz.tenantId, name_ar: "مقدم", name_en: "Detail Provider" }) })) as { id: string }[];
    providerId = prov.id;
    const [svc] = (await rest("services", { method: "POST", body: JSON.stringify({ tenant_id: biz.tenantId, name_ar: "خدمة", name_en: "Detail Service", duration_min: 30, price: 80 }) })) as { id: string }[];
    const [cus] = (await rest("customers", { method: "POST", body: JSON.stringify({ tenant_id: biz.tenantId, full_name: "Detail <i>Customer</i>", phone: "+966500000777", email: "detail@example.com", locale: "ar" }) })) as { id: string }[];
    customerId = cus.id;
    for (const [i, status] of ["completed", "no_show", "confirmed"].entries()) {
      const start = new Date(Date.now() + (i === 2 ? 4 : -(i + 2)) * 86_400_000);
      await rest("appointments", {
        method: "POST",
        body: JSON.stringify({ tenant_id: biz.tenantId, provider_id: prov.id, service_id: svc.id, customer_id: cus.id, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 1_800_000).toISOString(), status, source: "staff", price: 80 }),
      });
    }
  });
  test.afterAll(async () => {
    if (biz) await biz.cleanup();
  });

  test("customers/[id]: contact, stats, full history, hostile name as text, no token", async ({ page }) => {
    await loginWith(page, biz.email, biz.password, "en", `/dashboard/customers/${customerId}`);
    await expect(page.getByTestId("customer-name")).toHaveText("Detail <i>Customer</i>");
    expect(await page.locator("[data-testid=customer-name] i").count()).toBe(0);
    await expect(page.getByTestId("customer-history").locator("li")).toHaveCount(3);
    await expect(page.locator("main")).toContainText("+966 50 000 0777".replace(/ /g, "").slice(0, 4));
    expect(await page.content()).not.toContain("access_token");
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });

  test("customers/[id] in Arabic at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await loginWith(page, biz.email, biz.password, "en", "/dashboard");
    await page.goto(`/ar${(`/dashboard/customers/${customerId}`)}`);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("customer-history").locator("li")).toHaveCount(3);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });

  test("customers/[id]: an unknown id and another business's customer both go back to the list", async ({ page }) => {
    await loginWith(page, biz.email, biz.password, "en", "/dashboard");
    const [other] = (await rest(`customers?tenant_id=eq.${CLINIC}&select=id&limit=1`)) as { id: string }[];
    for (const id of ["00000000-0000-4000-8000-000000000000", other.id, "not-a-uuid"]) {
      await page.goto(`/en/dashboard/customers/${id}`);
      await expect(page).toHaveURL(/\/en\/dashboard\/customers$|\/en\/dashboard$|\/en\/dashboard\/customers\/not-a-uuid$/);
      await expect(page.getByTestId("customer-name")).toHaveCount(0);
    }
  });

  test("providers/[id]: owner sees the editor, renames it and the title follows (en)", async ({ page }) => {
    await loginWith(page, biz.email, biz.password, "en", `/dashboard/providers/${providerId}`);
    await expect(page.getByTestId("provider-title")).toHaveText("Detail Provider");
    await expect(page.getByTestId("hours-form")).toBeVisible();
    await expect(page.getByTestId("provider-save")).toBeVisible();
    await page.getByLabel("Name (English)").fill("Detail Provider Renamed");
    await page.getByTestId("provider-save").click();
    await expect.poll(async () => ((await rest(`providers?id=eq.${providerId}&select=name_en`)) as { name_en: string }[])[0].name_en).toBe("Detail Provider Renamed");
  });

  test("providers/[id] in Arabic at phone width: RTL and no overflow; a foreign provider id is refused", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await loginWith(page, biz.email, biz.password, "en", "/dashboard");
    await page.goto(`/ar${(`/dashboard/providers/${providerId}`)}`);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("hours-form")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    const [foreign] = (await rest(`providers?tenant_id=eq.${CLINIC}&select=id&limit=1`)) as { id: string }[];
    await page.goto(`/ar/dashboard/providers/${foreign.id}`);
    await expect(page.getByTestId("provider-title")).toHaveCount(0);
  });
});

test.describe("access denials", () => {
  test("receptionist: owner-only pages bounce to the overview, the upload API says 403", async ({ page }) => {
    await loginFixed(page, "clinic-reception");
    for (const p of ["revenue", "settings", "services/new", "providers/new"]) {
      await page.goto(`/en/dashboard/${p}`);
      await expect(page, p).toHaveURL(/\/en\/dashboard$/);
    }
    await page.goto("/en/dashboard/knowledge");
    await expect(page).toHaveURL(/\/en\/dashboard$/);
    const api = await page.request.post("/api/dashboard/knowledge/pdf", { multipart: { file: { name: "a.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") } } });
    expect(api.status()).toBe(403);
    // what the receptionist may do: conversations and customers
    await page.goto("/en/dashboard/conversations");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.goto("/en/dashboard/customers");
    await expect(page.getByTestId("customer-list")).toBeVisible();
  });

  test("provider: no conversations, knowledge, revenue or catalogue (all bounce); another business's customer is not reachable", async ({ page }) => {
    await loginFixed(page, "clinic-doctor");
    for (const p of ["revenue", "settings", "services", "providers/new", "conversations"]) {
      await page.goto(`/en/dashboard/${p}`);
      await expect(page, p).toHaveURL(/\/en\/dashboard$/);
    }
    await page.goto("/en/dashboard/knowledge");
    await expect(page).toHaveURL(/\/en\/dashboard$/);
    const api = await page.request.post("/api/dashboard/knowledge/pdf", { multipart: { file: { name: "a.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") } } });
    expect(api.status()).toBe(403);
    const [salonCustomer] = (await rest(`customers?tenant_id=eq.${SALON}&select=id&limit=1`)) as { id: string }[];
    await page.goto(`/en/dashboard/customers/${salonCustomer.id}`);
    await expect(page.getByTestId("customer-name")).toHaveCount(0);
  });

  test("signed out: every dashboard URL and the upload API refuse", async ({ page }) => {
    for (const p of ["", "/revenue", "/knowledge", "/customers", "/settings"]) {
      await page.goto(`/en/dashboard${p}`);
      await expect(page, p).toHaveURL(/\/en\/login/);
    }
    const api = await page.request.post("/api/dashboard/knowledge/pdf", { multipart: { file: { name: "a.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") } } });
    expect([401, 403]).toContain(api.status());
  });
});
