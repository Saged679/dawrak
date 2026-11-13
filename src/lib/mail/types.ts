export type MailKind = "24h" | "2h" | "booking" | "link";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Tenant the mail is about (the outbox refuses anything that is not a demo tenant). */
  tenantId: string;
  kind: MailKind;
  /** Hash of the visitor's demo session: required by the outbox, ignored by real providers. */
  sessionHash?: string | null;
  /** Used as the provider's idempotency key where supported. */
  idempotencyKey?: string;
};

/** `retryable` = worth trying again later (network, 429, 5xx); false = will never work (4xx). */
export class MailError extends Error {
  constructor(
    public code: string,
    public retryable: boolean,
  ) {
    super(code);
    this.name = "MailError";
  }
}

export interface MailProvider {
  readonly name: "resend" | "outbox";
  send(msg: MailMessage): Promise<{ id: string | null }>;
}
