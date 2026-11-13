/**
 * Single gate for the scripted e2e chat model. Pure and tiny: the chat route imports this, and only
 * when it returns true does it dynamically import ./mock-model. All of these must hold:
 *  - DAWRAK_MOCK_CHAT_MODEL=1 and the request header `x-dawrak-e2e-model: 1`
 *  - not on Vercel
 *  - in a production build (NODE_ENV=production, which `next start` is), ALSO ALLOW_E2E_MOCKS=true
 * Only playwright.config.ts's web server env sets these.
 */
export function e2eMockEnabled(
  headers: Pick<Headers, "get">,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.DAWRAK_MOCK_CHAT_MODEL !== "1" || env.VERCEL) return false;
  if (env.NODE_ENV === "production" && env.ALLOW_E2E_MOCKS !== "true") return false;
  return headers.get("x-dawrak-e2e-model") === "1";
}
