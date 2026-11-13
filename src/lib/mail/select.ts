import { createResendProvider } from "./resend";
import { createOutboxProvider, type OutboxWriter } from "./outbox";
import { MailError, type MailProvider } from "./types";

export type MailEnv = {
  MAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
};

/**
 * Which provider sends for a tenant. A demo tenant ALWAYS gets the outbox, whatever the environment
 * says, so no real e-mail can ever leave for demo data. Other tenants follow MAIL_PROVIDER:
 *   resend (+ RESEND_API_KEY, optional MAIL_FROM) -> Resend
 *   anything else or unset                        -> "not configured" error (the outbox only accepts
 *                                                    demo tenants, so a real tenant never lands there)
 */
export function selectMailProvider(
  tenant: { is_demo: boolean },
  env: MailEnv,
  deps: { outboxWriter: OutboxWriter; fetchImpl?: typeof fetch },
): MailProvider {
  if (tenant.is_demo) return createOutboxProvider(deps.outboxWriter);
  if (env.MAIL_PROVIDER === "resend") {
    if (!env.RESEND_API_KEY) throw new MailError("mail_not_configured", true);
    return createResendProvider({
      apiKey: env.RESEND_API_KEY,
      from: env.MAIL_FROM || "Dawrak <onboarding@resend.dev>",
      fetchImpl: deps.fetchImpl,
    });
  }
  throw new MailError("mail_not_configured", true);
}
