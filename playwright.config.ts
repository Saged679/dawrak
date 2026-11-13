import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // deletes the temporary demo visitors that the specs create (cap 150 per demo business)
  globalSetup: "./e2e/helpers/global-cleanup.ts",
  globalTeardown: "./e2e/helpers/global-cleanup.ts",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    // voice notes: Chromium fake microphone, permission pre-granted (individual tests override it to simulate denial)
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://localhost:3000/ar",
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
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
    },
    timeout: 180_000,
  },
});
