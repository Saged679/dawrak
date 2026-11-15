import { expect, test, type Page } from "@playwright/test";
import { CLINIC, SALON, SERVICE_KEY, SUPABASE_URL, createTempTenant, enterDemo, loginFixed, loginWith, rest, restShared, type TempTenant } from "./helpers/tenant";

/**
 * Knowledge base and conversations pages against the LOCAL Supabase stack. The knowledge-base management
 * flows run against a TEMPORARY NON-demo business (the seeded demo knowledge base is locked for demo
 * visitors, see e2e/demo-readonly.spec.ts); conversations use the seeded demo clinic read-only.
 * Embeddings use the offline mock: the app server must run with DAWRAK_MOCK_EMBEDDINGS=1 (the
 * Playwright webServer config sets it). The service-role key only inspects and cleans up rows.
 */
const enter = (page: Page, persona: string, locale = "en") => enterDemo(page, persona, locale);
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const link = (p: Page, name: string) => p.getByRole("link", { name, exact: true }).locator("visible=true");

function buildPdf(text: string): Buffer {
  const stream = text ? `BT /F1 18 Tf 20 100 Td (${text}) Tj ET` : "0 0 m 10 10 l S";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}

test.beforeAll(() => {
  test.skip(!SUPABASE_URL || !SERVICE_KEY, "local Supabase env is missing");
});

test.describe("owner manages the knowledge base", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "chromium", "mutating flows run once");
  });
  const stamp = Date.now().toString(36);
  let biz: TempTenant;
  test.beforeAll(async () => {
    test.skip(!SUPABASE_URL || !SERVICE_KEY, "local Supabase env is missing");
    biz = await createTempTenant({ label: "kb" });
  });
  test.afterAll(async () => {
    if (biz) await biz.cleanup(); // cascades the documents and chunks
  });

  test("adds a FAQ: chunks are stored for the session tenant with embeddings", async ({ page }) => {
    await loginWith(page, biz.email, biz.password);
    await link(page, "Knowledge").click();
    await expect(page.getByRole("heading", { level: 1, name: "Knowledge base" })).toBeVisible();

    await page.getByTestId("faq-question").fill(`E2E ${stamp} Is parking free?`);
    await page.getByTestId("faq-answer").fill("Yes, parking is free behind the clinic for two hours.");
    await page.getByTestId("faq-submit").click();
    await expect(page.getByTestId("faq-msg")).toContainText("Saved and indexed");

    const docs = (await rest(`kb_documents?tenant_id=eq.${biz.tenantId}&title=like.*E2E ${stamp}*&select=id,tenant_id,source_type,content`)) as {
      id: string;
      source_type: string;
    }[];
    expect(docs).toHaveLength(1);
    expect(docs[0].source_type).toBe("faq");
    const chunks = (await rest(`kb_chunks?document_id=eq.${docs[0].id}&select=tenant_id,content,embedding`)) as {
      tenant_id: string;
      embedding: string | null;
    }[];
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.tenant_id).toBe(biz.tenantId);
      expect(c.embedding).not.toBeNull();
    }
    // no row for this document leaked into another tenant
    expect(await rest(`kb_chunks?tenant_id=eq.${SALON}&document_id=eq.${docs[0].id}&select=id`)).toHaveLength(0);

    const row = page.getByTestId(`kb-doc-${docs[0].id}`);
    await expect(row).toHaveAttribute("data-status", "ready");
    await expect(row.getByTestId("kb-status")).toHaveText("Ready");
    expect(await noOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("a document whose embedding fails is marked not indexed, kept for retry, and deletable", async ({ page }) => {
    await loginWith(page, biz.email, biz.password);
    await page.goto("/en/dashboard/knowledge");
    await page.getByTestId("text-title").fill(`E2E ${stamp} broken`);
    await page.getByTestId("text-content").fill("This text FAILME to index.");
    await page.getByTestId("text-submit").click();
    await expect(page.getByTestId("text-msg")).toContainText("could not index");
    await expect(page.getByTestId("text-msg")).toContainText("Retry");

    const docs = (await rest(`kb_documents?tenant_id=eq.${biz.tenantId}&title=like.*E2E ${stamp} broken*&select=id`)) as { id: string }[];
    expect(docs).toHaveLength(1);
    expect(await rest(`kb_chunks?document_id=eq.${docs[0].id}&select=id`)).toHaveLength(0);
    const row = page.getByTestId(`kb-doc-${docs[0].id}`);
    await expect(row).toHaveAttribute("data-status", "failed");
    await expect(row.getByTestId("kb-status")).toHaveText("Not indexed");

    await page.getByTestId(`doc-reindex-${docs[0].id}`).click();
    await expect(row.getByTestId("doc-error")).toBeVisible(); // still failing in the mock
    await expect(row).toHaveAttribute("data-status", "failed");

    await page.getByTestId(`doc-delete-${docs[0].id}`).click();
    await page.getByTestId(`doc-delete-confirm-${docs[0].id}`).click();
    await expect(row).toHaveCount(0);
    expect(await rest(`kb_documents?id=eq.${docs[0].id}&select=id`)).toHaveLength(0);
  });

  test("uploads a PDF, rejects a fake PDF and a scan, and renders hostile titles as text", async ({ page }) => {
    await loginWith(page, biz.email, biz.password);
    await page.goto("/en/dashboard/knowledge");

    await page.getByTestId("pdf-title").fill(`E2E ${stamp} <img src=x onerror=alert(1)>`);
    await page.getByTestId("pdf-file").setInputFiles({
      name: "policy.pdf",
      mimeType: "application/pdf",
      buffer: buildPdf("Cancellation is free up to two hours before the visit"),
    });
    await page.getByTestId("pdf-submit").click();
    await expect(page.getByTestId("pdf-msg")).toContainText("Saved and indexed");
    await expect(page.getByTestId("kb-list").getByText("<img src=x onerror=alert(1)>", { exact: false })).toBeVisible();
    expect(await page.locator("img[src='x']").count()).toBe(0);

    await page.getByTestId("pdf-file").setInputFiles({
      name: "fake.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("<html>not a pdf</html>"),
    });
    await page.getByTestId("pdf-submit").click();
    await expect(page.getByTestId("pdf-msg")).toContainText("not a PDF");

    await page.getByTestId("pdf-file").setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: buildPdf("") });
    await page.getByTestId("pdf-submit").click();
    await expect(page.getByTestId("pdf-msg")).toContainText("no readable text");
  });

  test("the upload endpoint refuses anonymous requests", async ({ request }) => {
    const res = await request.post("/api/dashboard/knowledge/pdf", {
      multipart: { file: { name: "a.pdf", mimeType: "application/pdf", buffer: buildPdf("hi") } },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe("role gating", () => {
  test("a receptionist and a provider cannot open the knowledge page; the owner sees it in the nav", async ({ page }) => {
    await enter(page, "clinic-reception");
    await expect(link(page, "Knowledge")).toHaveCount(0);
    await expect(link(page, "Conversations")).toHaveCount(1);
    await page.goto("/en/dashboard/knowledge");
    await expect(page).toHaveURL(/\/en\/dashboard$/);

    await page.context().clearCookies();
    await loginFixed(page, "clinic-doctor");
    await expect(link(page, "Knowledge")).toHaveCount(0);
    await expect(link(page, "Conversations")).toHaveCount(0);
    await page.goto("/en/dashboard/knowledge");
    await expect(page).toHaveURL(/\/en\/dashboard$/);
    await page.goto("/en/dashboard/conversations");
    await expect(page).toHaveURL(/\/en\/dashboard$/);
    await page.goto("/ar/dashboard/conversations/cc000000-0000-4000-8000-000000000001");
    await expect(page).toHaveURL(/\/ar\/dashboard$/);

    await page.context().clearCookies();
    await enter(page, "clinic-owner");
    await expect(link(page, "Knowledge")).toHaveCount(1);
  });
});

for (const locale of ["ar", "en"] as const) {
  for (const width of [360, 1280]) {
    test(`conversations list and thread render in ${locale} at ${width}px`, async ({ page }) => {
      test.skip(test.info().project.name !== "chromium", "viewport is set explicitly");
      await page.setViewportSize({ width, height: 800 });
      await enter(page, "clinic-reception", locale);
      await page.goto(`/${locale}/dashboard/conversations`);
      await expect(page.getByTestId("conv-list")).toBeVisible();
      const items = page.getByTestId("conv-list").locator("li");
      expect(await items.count()).toBeGreaterThanOrEqual(3);
      expect(await noOverflow(page)).toBeLessThanOrEqual(0);

      await page.getByTestId("conv-cc000000-0000-4000-8000-000000000001").click();
      await page.waitForURL(/\/dashboard\/conversations\/cc0/);
      const msgs = page.getByTestId("thread-messages").locator("li");
      await expect(msgs).toHaveCount(6);
      await expect(msgs.nth(0)).toHaveAttribute("data-role", "user");
      await expect(msgs.nth(1)).toHaveAttribute("data-role", "assistant");
      expect(await noOverflow(page)).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.dir)).toBe(locale === "ar" ? "rtl" : "ltr");
      await page.screenshot({ path: `test-results/conv-${locale}-${width}.png`, fullPage: true });
    });
  }
}

test("a thread links to the appointment the assistant booked", async ({ page }) => {
  test.skip(test.info().project.name !== "chromium", "mutating flow runs once");
  const conv = "cc000000-0000-4000-8000-000000000002";
  const [c] = (await rest(`conversations?id=eq.${conv}&select=customer_id,last_message_at`)) as { customer_id: string; last_message_at: string }[];
  const [svc] = (await rest(`services?tenant_id=eq.${CLINIC}&select=id,provider_services(provider_id)&limit=1`)) as {
    id: string;
    provider_services: { provider_id: string }[];
  }[];
  const start = new Date(Date.now() + 40 * 86_400_000);
  start.setUTCHours(9, 0, 0, 0);
  const appt = await restShared<{ id: string }>("appointments", {
      tenant_id: CLINIC,
      provider_id: svc.provider_services[0].provider_id,
      service_id: svc.id,
      customer_id: c.customer_id,
      starts_at: start.toISOString(),
      ends_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
      status: "confirmed",
      source: "chat",
      created_at: c.last_message_at,
    });
  try {
    await enter(page, "clinic-owner");
    await page.goto(`/en/dashboard/conversations/${conv}`);
    await expect(page.getByTestId("thread-appointments")).toBeVisible();
    await expect(page.getByTestId(`thread-appt-${appt.id}`)).toHaveAttribute("href", /\/en\/dashboard\/calendar\?date=\d{4}-\d{2}-\d{2}/);
  } finally {
    await rest(`appointments?id=eq.${appt.id}`, { method: "DELETE" });
  }
});
