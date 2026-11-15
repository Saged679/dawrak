import { defineConfig, devices } from "@playwright/test";

// Ports and the build directory can be overridden (E2E_PORT, E2E_PORT2, NEXT_DIST_DIR) so a run never collides with a
// dev/prod server that is already using 3000 or 3001. Defaults are unchanged.
const PORT = process.env.E2E_PORT ?? "3000";
const PORT2 = process.env.E2E_PORT2 ?? "3001";
const DIST: Record<string, string> = process.env.NEXT_DIST_DIR ? { NEXT_DIST_DIR: process.env.NEXT_DIST_DIR } : {};
// Demo sign-in is limited per IP in production (3/h, 10/day); every e2e visitor shares one IP, so lift it here.
const DEMO_LIMITS = { DEMO_SIGNIN_PER_HOUR: "100000", DEMO_SIGNIN_PER_DAY: "100000" };

const CHROMIUM_MEDIA = {
  permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
};
const SMOKE = /(home|landing|seo|llms|booking-invalid|demo-visitors|status-pages).spec.ts/;
const WEBKIT_STATIC = /(home|seo|llms).spec.ts/;

export default defineConfig({
  testDir: "./e2e",
  // deletes the temporary demo visitors that the specs create (cap 150 per demo business)
  globalSetup: "./e2e/helpers/global-cleanup.ts",
  globalTeardown: "./e2e/helpers/global-cleanup.ts",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    // chromium and mobile: the whole suite. Voice notes use Chromium's fake microphone, permission pre-granted
    // (individual tests override it to simulate denial); Firefox and WebKit reject those options.
    // The default server has the fake payment provider. payments-unavailable.spec.ts needs the opposite
    // (no provider at all), so it runs only in its own project against the second server on port 3001.
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...CHROMIUM_MEDIA }, testIgnore: /payments-unavailable.spec.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"], ...CHROMIUM_MEDIA }, testIgnore: /payments-unavailable.spec.ts/ },
    // Cross-browser smoke only (landing, SEO head, public booking incl. invalid input, llms.txt, demo visitors,
    // status pages): keeps the default `npm run test:e2e` runtime reasonable.
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, testMatch: SMOKE },
// WebKit honours the CSP "upgrade-insecure-requests" even for http://localhost (Chromium and Firefox exempt it; bypassCSP
    // does not help), so against the local production build every script, font and the local Supabase URL are fetched
    // over https and fail: nothing hydrates. Only pages that work without JavaScript run here (SEO head, llms.txt, home).
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testMatch: WEBKIT_STATIC },
    {
      name: "no-payments",
      testMatch: /payments-unavailable.spec.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${PORT2}` },
    },
  ],
  webServer: [{
    command: `npm run build && npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}/ar`,
    reuseExistingServer: true,
    // the knowledge base e2e embeds with the offline mock (no Gemini key in CI)
    // Everything the demo/e2e needs is opted into explicitly: none of it is a default any more.
    env: {
      DAWRAK_MOCK_EMBEDDINGS: "1",
      DEMO_MODE: "true",
      PAYMENT_PROVIDER: "fake",
      ALLOW_FAKE_PAYMENTS: "true", // `next start` is a production build, which refuses fake otherwise
      FAKE_WEBHOOK_SECRET: "dawrak-fake-webhook-secret", // same literal as e2e/payments.spec.ts
      CRON_SECRET: "dawrak-e2e-cron-secret-0123456789", // same literal as e2e/reminders.spec.ts
      ALLOW_E2E_MOCKS: "true", // also enables the test-only /boom route (404 without it); second opt-in: a production build (next start) ignores the mock model without it
      DAWRAK_MOCK_CHAT_MODEL: "1", // offline scripted model for e2e/chat-booking-mail.spec.ts (refused on Vercel)
      MAIL_PROVIDER: "resend", // proves demo tenants still use the outbox: no key is set, a real send would fail
      NEXT_PUBLIC_SITE_URL: `http://localhost:${PORT}`,
      TRUSTED_PROXY_HEADER: "x-forwarded-for", // lets a spec pick its own rate-limit bucket (e2e/helpers/site.ts ownIpHeaders)
      ...DIST,
      ...DEMO_LIMITS,
    },
    timeout: 180_000,
  },
  {
    // Same build, but NO payment provider (no PAYMENT_PROVIDER, no Moyasar key, no ALLOW_FAKE_PAYMENTS):
    // what production looks like before the Moyasar test keys exist. Starts after the first server (build done).
    command: `npm run start -- -p ${PORT2}`,
    url: `http://localhost:${PORT2}/ar`,
    reuseExistingServer: true,
    env: {
      DAWRAK_MOCK_EMBEDDINGS: "1",
      DEMO_MODE: "true",
      PAYMENT_PROVIDER: "",
      MOYASAR_SECRET_KEY: "",
      ALLOW_FAKE_PAYMENTS: "",
      FAKE_WEBHOOK_SECRET: "",
      CRON_SECRET: "dawrak-e2e-cron-secret-0123456789",
      ALLOW_E2E_MOCKS: "true",
      DAWRAK_MOCK_CHAT_MODEL: "1",
      MAIL_PROVIDER: "resend",
      NEXT_PUBLIC_SITE_URL: `http://localhost:${PORT2}`,
      TRUSTED_PROXY_HEADER: "x-forwarded-for",
      ...DIST,
      ...DEMO_LIMITS,
    },
    timeout: 60_000,
  }],
});
