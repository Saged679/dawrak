import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Test-only route that throws, used by the error-boundary e2e. It must not exist in production: it 404s
 * unless ALLOW_E2E_MOCKS is exactly "true" (set only by playwright.config.ts).
 */
export default function Boom() {
  if (process.env.ALLOW_E2E_MOCKS !== "true") notFound();
  throw new Error("SECRET-INTERNAL-DETAIL");
}
