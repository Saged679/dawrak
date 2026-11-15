import { ownIpHeaders } from "./helpers/site";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * Widget behaviour for assistant quota errors and Markdown replies, driven through the REAL chat route with the
 * offline scripted model (DAWRAK_MOCK_CHAT_MODEL=1): user text QUOTA / QUOTA_MINUTE makes the model fail like
 * Gemini's free-tier 429 RESOURCE_EXHAUSTED; MARKDOWN makes it answer with Markdown.
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

test.describe("chat widget: assistant quota and Markdown", () => {
  test.skip(!SUPABASE_URL || !SERVICE_KEY, "needs the local Supabase stack");
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "runs once");
  });
  test.beforeAll(async () => {
    // the chat route limits per IP (all local requests share one bucket): start from a clean slate
    await fetch(`${SUPABASE_URL}/rest/v1/rate_limits?key=like.ip:*`, {
      method: "DELETE",
      headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}` },
    });
  });

  async function openChat(page: import("@playwright/test").Page, locale: "en" | "ar") {
    await page.setExtraHTTPHeaders(ownIpHeaders({ "x-dawrak-e2e-model": "1" }));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/${locale}/c/demo-clinic`, { waitUntil: "networkidle" });
    return page.getByTestId("chat-widget");
  }

  test("daily quota (en): clear message and a button that goes to the booking form", async ({ page }) => {
    const chat = await openChat(page, "en");
    await chat.getByLabel("Your message to the assistant").fill("QUOTA");
    await chat.getByRole("button", { name: "Send" }).click();
    const err = chat.getByTestId("chat-error");
    await expect(err).toBeVisible({ timeout: 30_000 });
    await expect(err).toContainText("reached today's free usage limit");
    await expect(err).toContainText("booking form works");
    await expect(err).not.toContainText("Something went wrong");
    await chat.getByTestId("chat-go-to-form").click();
    await expect(page.locator("#booking-title")).toBeInViewport();
    await expect(page.locator("#booking-title")).toBeFocused();
  });

  test("daily quota (ar): localized message", async ({ page }) => {
    const chat = await openChat(page, "ar");
    await chat.getByLabel("رسالتك إلى المساعد").fill("QUOTA");
    await chat.getByRole("button", { name: "إرسال" }).click();
    const err = chat.getByTestId("chat-error");
    await expect(err).toBeVisible({ timeout: 30_000 });
    await expect(err).toContainText("المجاني لهذا اليوم");
    await expect(err).toContainText("نموذج الحجز");
    await expect(chat.getByTestId("chat-go-to-form")).toBeVisible();
  });

  test("per-minute limit is 'busy, try again', not 'today's limit'", async ({ page }) => {
    const chat = await openChat(page, "en");
    await chat.getByLabel("Your message to the assistant").fill("QUOTA_MINUTE");
    await chat.getByRole("button", { name: "Send" }).click();
    const err = chat.getByTestId("chat-error");
    await expect(err).toContainText("busy for a moment", { timeout: 30_000 });
    await expect(err).not.toContainText("today's free usage limit");
  });

  test("Markdown in an assistant reply is shown as plain text", async ({ page }) => {
    const chat = await openChat(page, "en");
    await chat.getByLabel("Your message to the assistant").fill("MARKDOWN");
    await chat.getByRole("button", { name: "Send" }).click();
    const bubble = chat.locator('[data-from="assistant"]').filter({ hasText: "Options:" });
    await expect(bubble).toBeVisible({ timeout: 30_000 });
    const text = await bubble.innerText();
    expect(text).toContain("• Early slot");
    expect(text).toContain("• Late slot");
    expect(text).not.toMatch(/\*|__/);
  });
});
