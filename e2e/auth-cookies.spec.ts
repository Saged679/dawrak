import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ANON_KEY, FIXED_DEMO_PASSWORD, FIXED_USERS, SERVICE_KEY, SUPABASE_URL, clearRateLimits, enterDemo } from "./helpers/tenant";

/**
 * L1: every Supabase auth cookie is HttpOnly (and Secure in a production build, which is what `next start`
 * runs here), set at login and at demo entry; login, refresh through the proxy and logout still work.
 */
test.skip(!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY, "needs the local Supabase stack");
test.beforeEach(() => {
  test.skip(test.info().project.name !== "chromium", "runs once");
});

const authCookies = async (ctx: BrowserContext) => (await ctx.cookies()).filter((c) => /^sb-.*-auth-token/.test(c.name));

async function expectHardened(ctx: BrowserContext) {
  const cookies = await authCookies(ctx);
  expect(cookies.length).toBeGreaterThan(0);
  for (const c of cookies) {
    expect(c.httpOnly, `${c.name} httpOnly`).toBe(true);
    expect(c.secure, `${c.name} secure (production build)`).toBe(true);
    expect(c.sameSite, `${c.name} sameSite`).toBe("Lax");
  }
  return cookies;
}

/** No script on the page can see an auth cookie. */
async function expectInvisibleToScripts(page: Page) {
  expect(await page.evaluate(() => document.cookie)).not.toMatch(/sb-/);
}

test("login sets only HttpOnly auth cookies; the session survives navigation and logout clears it", async ({ page, context }) => {
  await clearRateLimits();
  await page.goto("/en/login?next=/dashboard/calendar");
  await page.getByLabel("Email").fill(FIXED_USERS["clinic-owner"]);
  await page.getByLabel("Password").fill(FIXED_DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/en\/dashboard\/calendar/);
  const cookies = await expectHardened(context);
  const maxAge = Math.min(...cookies.map((c) => c.expires)) - Date.now() / 1000;
  expect(maxAge).toBeGreaterThan(6 * 86_400);
  expect(maxAge).toBeLessThanOrEqual(7 * 86_400 + 60);
  await expectInvisibleToScripts(page);
  await page.goto("/en/dashboard/customers");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.locator("summary").first().click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/en\/login/);
  expect((await authCookies(context)).filter((c) => c.value !== "")).toHaveLength(0);
  await page.goto("/en/dashboard");
  await expect(page).toHaveURL(/\/en\/login/);
});

test("demo entry sets HttpOnly cookies that last about 6 hours", async ({ page, context }) => {
  await enterDemo(page, "clinic-owner");
  const cookies = await expectHardened(context);
  const left = Math.max(...cookies.map((c) => c.expires)) - Date.now() / 1000;
  expect(left).toBeGreaterThan(5 * 3600);
  expect(left).toBeLessThanOrEqual(6 * 3600 + 60);
  await expectInvisibleToScripts(page);
});

test("a refresh through the proxy keeps the cookies HttpOnly and the session working", async ({ page, context }) => {
  await clearRateLimits();
  await page.goto("/en/login");
  await page.getByLabel("Email").fill(FIXED_USERS["clinic-reception"]);
  await page.getByLabel("Password").fill(FIXED_DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/en\/dashboard/);

  // Make the stored access token look expired so the next request must refresh it with the refresh token.
  const cookies = await authCookies(context);
  const base = cookies[0].name.replace(/\.\d+$/, "");
  const joined = cookies
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => c.value)
    .join("");
  const raw = joined.startsWith("base64-") ? joined.slice(7) : joined;
  const session = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { expires_at: number; access_token: string };
  const oldAccess = session.access_token;
  session.expires_at = Math.floor(Date.now() / 1000) - 60;
  const forged = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  const first = cookies[0];
  await context.clearCookies({ name: /^sb-.*-auth-token/ });
  await context.addCookies([{ name: base, value: forged, domain: first.domain, path: "/", httpOnly: true, secure: true, sameSite: "Lax", expires: first.expires }]);

  await page.goto("/en/dashboard/calendar");
  await expect(page).toHaveURL(/\/en\/dashboard\/calendar/); // still signed in: the proxy refreshed it
  const after = await expectHardened(context);
  const afterJoined = after
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => c.value)
    .join("");
  const fresh = JSON.parse(Buffer.from(afterJoined.replace(/^base64-/, ""), "base64url").toString("utf8")) as { access_token: string; expires_at: number };
  expect(fresh.access_token).not.toBe(oldAccess);
  expect(fresh.expires_at).toBeGreaterThan(Date.now() / 1000);
});
