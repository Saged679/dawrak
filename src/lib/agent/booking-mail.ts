import type { PublicTenant } from "@/lib/db/public";
import { sendBookingEmail } from "@/lib/customer/emails";
import type { AfterBooking, AgentDb, Locale } from "./types";

/** Placeholder recipient for a demo booking without an address; the demo outbox never delivers anywhere. */
export const DEMO_NO_EMAIL = "no-email-on-file@demo.invalid";

export type SendBookingEmail = typeof sendBookingEmail;

/**
 * Confirmation mail for a chat booking, with the web form's rules: only for a brand-new customer (the
 * only case where the database hands out a manage token), through the same sendBookingEmail. A demo
 * tenant's booking is bound to the visitor's session (reminders land in their mailbox) and its mail
 * goes to the demo outbox; a real tenant goes through the configured provider. Never throws.
 */
export function createAfterBooking(opts: {
  db: AgentDb;
  tenant: Pick<PublicTenant, "id" | "slug" | "is_demo">;
  locale: Locale;
  /** SHA-256 of the visitor's demo session cookie; null for real tenants. */
  sessionHash: string | null;
  send?: SendBookingEmail;
}): AfterBooking {
  const send = opts.send ?? sendBookingEmail;
  return async (b) => {
    const demo = opts.tenant.is_demo;
    if (demo && opts.sessionHash) {
      try {
        const { error } = await opts.db.rpc("demo_attach_session", {
          p_tenant_id: opts.tenant.id,
          p_appointment_id: b.appointmentId,
          p_session_hash: opts.sessionHash,
        });
        if (error) throw error;
      } catch (e) {
        console.error("demo_session_error", e instanceof Error ? e.message : "unknown");
        return "not_sent";
      }
    }
    const to = b.email ?? (demo ? DEMO_NO_EMAIL : null);
    if (!b.customerToken || !to) return "not_sent";
    if (demo && !opts.sessionHash) return "not_sent"; // the outbox needs a session; never fall back to real mail
    try {
      await send({
        tenant: opts.tenant,
        token: b.customerToken,
        appointmentId: b.appointmentId,
        email: to,
        locale: opts.locale,
        sessionHash: demo ? opts.sessionHash : null,
      });
      return demo ? "demo_mailbox" : "queued";
    } catch (e) {
      console.error("booking_email_error", e instanceof Error ? e.message : "unknown");
      return "not_sent";
    }
  };
}
