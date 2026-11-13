import { expect, test, type Page } from "@playwright/test";

/** Security headers + zero CSP violations on the main pages (needs local Supabase for login). */

test("security headers are set and the server banner is gone", async ({ request }) => {
  const res = await request.get("/en");
  const h = res.headers();
  expect(h["x-powered-by"]).toBeUndefined();
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  const pp = h["permissions-policy"];
  expect(pp).toContain("microphone=(self)");
  expect(pp).toContain("camera=()");
  expect(pp).toContain("geolocation=()");
  expect(pp).toContain("payment=()");
  const csp = h["content-security-policy"];
  expect(csp).toBeTruthy();
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("https://*.moyasar.com");
  expect(csp).not.toContain("unsafe-eval");
  // HSTS only in production builds (this suite runs against `next start`).
  expect(h["strict-transport-security"]).toContain("max-age=");
});

test("pages that hold personal links send no Referer, are not cached and not indexed", async ({ request }) => {
  // the payment pages carry the payment token in their URL (L6)
  for (const path of ["/en/demo/mailbox", "/ar/c/demo-salon/my", "/en/c/demo-clinic/pay/not-a-real-token", "/ar/c/demo-clinic/pay/not-a-real-token/result", "/en/c/demo-clinic/pay/not-a-real-token/fake"]) {
    const h = (await request.get(path)).headers();
    expect(h["referrer-policy"], path).toBe("no-referrer");
    expect(h["cache-control"], path).toContain("no-store");
    expect(h["x-robots-tag"], path).toContain("noindex");
  }
});

function collectViolations(page: Page) {
  const found: string[] = [];
  page.on("console", (m) => {
    if (/content security policy|violates the following/i.test(m.text())) found.push(m.text());
  });
  page.on("pageerror", (e) => {
    if (/content security policy/i.test(e.message)) found.push(e.message);
  });
  return found;
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        document.addEventListener("securitypolicyviolation", () => {}, { once: true });
        setTimeout(resolve, 300);
      }),
  );
}

const PUBLIC = ["/ar", "/en", "/en/demo", "/ar/demo", "/en/login", "/en/c/demo-clinic", "/ar/c/demo-clinic", "/en/c/demo-salon/my", "/en/demo/mailbox"];

for (const path of PUBLIC) {
  test(`no CSP violations on ${path}`, async ({ page }) => {
    const violations = collectViolations(page);
    await page.goto(path);
    await settle(page);
    expect(violations).toEqual([]);
  });
}

test("no CSP violations in the chat widget and the dashboard", async ({ page }) => {
  const violations = collectViolations(page);
  await page.goto("/en/c/demo-clinic");
  await settle(page);
  const open = page.getByRole("button", { name: /chat|assistant/i }).first();
  if (await open.isVisible().catch(() => false)) await open.click();
  await expect(page.getByTestId("chat-widget")).toBeVisible();
  expect(violations).toEqual([]);

  await page.goto("/en/demo");
  await page.getByTestId("demo-clinic-owner").click();
  await page.waitForURL(/\/en\/dashboard/);
  await settle(page);
  for (const p of ["/en/dashboard/calendar", "/en/dashboard/customers"]) {
    await page.goto(p);
    await settle(page);
  }
  expect(violations).toEqual([]);
});
