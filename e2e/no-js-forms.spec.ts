import { expect, test, type Page, type Request } from "@playwright/test";
import { createTempTenant, hasLocalDb, loginWith } from "./helpers/tenant";

/**
 * Regression: pages are server-rendered, so a form submitted before React hydrates is submitted
 * natively by the browser. A <form> without method="post" then does a GET and puts every field in
 * the URL (history, server logs, referrers), including passwords. These tests keep the client JS
 * chunks from ever loading, so the page stays in its pre-hydration state, then submit the forms.
 * They deliberately do not use the hydration helper.
 */
const SECRET = "Sentinel-Pw-9731";
const EMAIL = "nobody-9731@example.com";
const NAME = "Sentinel Name 9731";

/** Aborts every Next.js client script so React never hydrates. */
async function blockClientJs(page: Page) {
  await page.route(/\/_next\/static\/.*\.js(\?.*)?$/, (route) => route.abort());
}

/** Records top-level navigations; a GET with a query string is the bug. */
function watchNavigations(page: Page) {
  const seen: { method: string; url: string }[] = [];
  page.on("request", (r: Request) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
      seen.push({ method: r.method(), url: r.url() });
    }
  });
  return seen;
}

function expectNoLeak(page: Page, seen: { method: string; url: string }[], needles: string[]) {
  const all = [page.url(), ...seen.map((s) => s.url)].map((u) => decodeURIComponent(u));
  for (const n of needles) for (const u of all) expect(u, `"${n}" leaked into a URL`).not.toContain(n);
  const getWithQuery = seen.filter((s) => s.method === "GET" && new URL(s.url).search !== "");
  expect(getWithQuery, "no GET navigation with a query string").toEqual([]);
  expect(new URL(page.url()).search).toBe("");
}

test.describe("forms submitted before hydration never put field values in the URL", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "chromium", "pre-hydration behaviour is browser independent");
  });

  test("login form (password)", async ({ page }) => {
    await blockClientJs(page);
    const seen = watchNavigations(page);
    await page.goto("/en/login");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(SECRET);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForLoadState("networkidle");
    expectNoLeak(page, seen, [SECRET, EMAIL, "password"]);
  });

  test("public booking form", async ({ page }) => {
    await blockClientJs(page);
    const seen = watchNavigations(page);
    await page.goto("/en/c/demo-clinic");
    const form = page.locator("main form").first();
    await expect(form).toBeVisible();
    await form.evaluate((f) => (f as HTMLFormElement).requestSubmit());
    await page.waitForLoadState("networkidle");
    expectNoLeak(page, seen, ["fullName=", "phone=", "email="]);
  });

  test("chat input", async ({ page }) => {
    await blockClientJs(page);
    const seen = watchNavigations(page);
    await page.goto("/en/c/demo-clinic");
    const input = page.locator("#chat-input");
    await input.fill(`${NAME} 0501234567`);
    // the send button is disabled in the server HTML, so force a submission like autofill could
    await input.evaluate((el) => (el.closest("form") as HTMLFormElement).requestSubmit());
    await page.waitForLoadState("networkidle");
    expectNoLeak(page, seen, [NAME, "0501234567"]);
  });

  test("dashboard service form", async ({ page }) => {
    // the demo catalogue is read-only (its form is disabled), so use a temporary non-demo business owner
    test.skip(!hasLocalDb(), "needs the local database");
    const biz = await createTempTenant({ label: "nojs" });
    try {
      // sign in with scripts, then reload without them
      await loginWith(page, biz.email, biz.password, "en");
      await blockClientJs(page);
      const seen = watchNavigations(page);
      await page.goto("/en/dashboard/services/new");
      await page.getByLabel("Name (Arabic)").fill(NAME);
      await page.getByLabel("Name (English)").fill(NAME);
      await page.getByTestId("service-save").click();
      await page.waitForLoadState("networkidle");
      expectNoLeak(page, seen, [NAME, "name_ar", "price="]);
    } finally {
      await biz.cleanup();
    }
  });
});
