import { MailError, type MailMessage, type MailProvider } from "./types";

/**
 * Resend over plain fetch (POST https://api.resend.com/emails, Bearer key, optional Idempotency-Key).
 * Free plan: 100 mails/day, 3000/month, and WITHOUT a verified domain only the account owner's own
 * address is accepted as recipient (403). Real tenants therefore need a verified sending domain.
 * No tracking: open/click tracking is a domain setting in Resend and is left off; no pixels in the HTML.
 */
export function createResendProvider(opts: {
  apiKey: string;
  from: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): MailProvider {
  const f = opts.fetchImpl ?? fetch;
  return {
    name: "resend",
    async send(msg: MailMessage) {
      let res: Response;
      try {
        res = await f("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
            ...(msg.idempotencyKey ? { "Idempotency-Key": msg.idempotencyKey.slice(0, 256) } : {}),
          },
          body: JSON.stringify({
            from: opts.from,
            to: [msg.to],
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
        });
      } catch {
        throw new MailError("network", true);
      }
      if (!res.ok) {
        // Never read the body into the error: it can echo the recipient address.
        const retryable = res.status === 429 || res.status >= 500;
        throw new MailError(`resend_${res.status}`, retryable);
      }
      const json = (await res.json().catch(() => null)) as { id?: unknown } | null;
      return { id: typeof json?.id === "string" ? json.id : null };
    },
  };
}
