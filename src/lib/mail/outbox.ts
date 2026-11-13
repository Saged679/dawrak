import { MailError, type MailMessage, type MailProvider } from "./types";

export type OutboxWriter = (a: {
  tenantId: string;
  sessionHash: string;
  kind: string;
  to: string;
  subject: string;
  text: string;
}) => Promise<void>;

/** Demo "mail provider": the message goes to the visitor's own demo mailbox, nowhere else. */
export function createOutboxProvider(write: OutboxWriter): MailProvider {
  return {
    name: "outbox",
    async send(msg: MailMessage) {
      if (!msg.sessionHash) throw new MailError("no_session", false);
      try {
        await write({
          tenantId: msg.tenantId,
          sessionHash: msg.sessionHash,
          kind: msg.kind,
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
        });
      } catch {
        throw new MailError("outbox_write", true);
      }
      return { id: null };
    },
  };
}
