import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { SERVICE_KEY, SUPABASE_URL, rest } from "./helpers/tenant";

/**
 * The booking e-mail is queued after the response, so a visitor who opens /demo/mailbox right away can see
 * it empty. The page watches for a few seconds and shows the mail without a manual reload.
 */
test.describe("demo mailbox live refresh", () => {
  test.skip(!SUPABASE_URL || !SERVICE_KEY, "needs the local Supabase stack");
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "runs once");
  });
  const phones: string[] = [];
  test.beforeAll(async () => {
    await rest("rate_limits?key=like.ip:*", { method: "DELETE" });
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

  test("books on the salon, opens the mailbox at once and the email appears without a reload", async ({ page }) => {
    const digits = Math.floor(Math.random() * 1e8).toString().padStart(8, "0");
    phones.push(`+9665${digits}`);
    const email = `live-${digits}@example.com`;
    await page.goto("/en/c/demo-salon");
    await page.getByText("Cut & Style", { exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    const slot = page.locator('input[name="slot-choice"]').first();
    await slot.waitFor({ state: "attached" });
    await slot.check({ force: true });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Full name").fill("Live Mailbox");
    await page.getByLabel("Mobile number").fill(`05${digits}`);
    await page.getByLabel(/^Email/).fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("heading", { name: "Your booking is confirmed" })).toBeVisible();

    // straight to the mailbox: the mail may still be queued
    await page.goto("/en/demo/mailbox");
    await expect(page.getByTestId("mailbox-message")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId("mailbox-message")).toContainText(email);
  });

  test("a mail that lands AFTER the page opened shows up by itself (deterministic late insert)", async ({ browser, baseURL }) => {
    const raw = randomBytes(32).toString("base64url");
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "dawrak_demo_session", value: raw, url: baseURL! }]);
    const page = await ctx.newPage();
    await page.goto("/en/demo/mailbox");
    await expect(page.getByTestId("mailbox-empty")).toBeVisible();
    await expect(page.getByTestId("mailbox-status")).toHaveText("Waiting for your email…");
    const [tenant] = await rest("tenants?slug=eq.demo-salon&select=id");
    await rest("demo_outbox", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenant.id,
        session_hash: createHash("sha256").update(raw).digest("hex"),
        kind: "booking",
        to_email: "late@example.com",
        subject: "Late booking mail",
        body_text: "queued after the response",
      }),
    });
    await expect(page.getByTestId("mailbox-message")).toHaveCount(1, { timeout: 12_000 });
    await expect(page.getByTestId("mailbox-message")).toContainText("Late booking mail");
    await rest(`demo_outbox?to_email=eq.late@example.com`, { method: "DELETE" });
    await ctx.close();
  });
  test("a visitor with no mail waits a few seconds, then sees the plain empty state; Refresh works without JS", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto("/en/demo/mailbox");
    await expect(page.getByTestId("mailbox-empty")).toBeVisible();
    await expect(page.getByTestId("mailbox-refresh")).toBeVisible();
    await page.getByTestId("mailbox-refresh").click();
    await expect(page).toHaveURL(/\/en\/demo\/mailbox$/);
    await expect(page.getByTestId("mailbox-empty")).toBeVisible();
    await ctx.close();
  });
});
