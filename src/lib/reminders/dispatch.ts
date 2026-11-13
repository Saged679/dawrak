import type { Loc } from "@/components/booking/dates";
import { renderEmail } from "@/lib/mail/templates";
import { MailError, type MailProvider } from "@/lib/mail/types";
import { MAX_ATTEMPTS, retryDelayMinutes } from "./policy";

export type ClaimedReminder = {
  reminderId: string;
  kind: "24h" | "2h";
  attempts: number;
  tenantId: string;
  tenantSlug: string;
  tenantNameAr: string;
  tenantNameEn: string | null;
  timezone: string;
  isDemo: boolean;
  appointmentId: string;
  startsAt: string;
  providerNameAr: string;
  providerNameEn: string | null;
  serviceNameAr: string;
  serviceNameEn: string | null;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  customerLocale: Loc;
  demoSessionHash: string | null;
};

export type CompleteOutcome =
  | { outcome: "sent" }
  | { outcome: "skipped"; error: string }
  | { outcome: "failed"; error: string }
  | { outcome: "retry"; error: string; retryAt: Date };

export interface ReminderStore {
  claim(limit: number): Promise<ClaimedReminder[]>;
  complete(id: string, r: CompleteOutcome): Promise<void>;
  /** Fresh magic-link token for the customer (issue_customer_magic_link), or null if there is none. */
  issueLink(tenantId: string, phone: string): Promise<string | null>;
}

export type DispatchDeps = {
  store: ReminderStore;
  /** Throws a MailError when the tenant has no usable provider. Demo tenants must get the outbox. */
  providerFor: (tenant: { is_demo: boolean }) => MailProvider;
  manageUrl: (locale: Loc, slug: string, token: string) => string;
  now?: () => Date;
  limit?: number;
  /** Pause between real sends (Resend allows 2 requests a second by default). */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type DispatchSummary = { claimed: number; sent: number; retried: number; failed: number; skipped: number };

const pick = (loc: Loc, ar: string | null, en: string | null) => (loc === "en" ? en || ar || "" : ar || en || "");

export async function dispatchDueReminders(deps: DispatchDeps): Promise<DispatchSummary> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rows = await deps.store.claim(deps.limit ?? 20);
  const sum: DispatchSummary = { claimed: rows.length, sent: 0, retried: 0, failed: 0, skipped: 0 };

  for (const r of rows) {
    let result: CompleteOutcome;
    let sentVia: MailProvider["name"] | null = null;
    try {
      if (r.isDemo && !r.demoSessionHash) {
        // seeded demo data: there is no visitor whose mailbox could show it
        result = { outcome: "skipped", error: "no_demo_session" };
      } else if (!r.isDemo && !r.customerEmail) {
        result = { outcome: "skipped", error: "no_email" };
      } else {
        const provider = deps.providerFor({ is_demo: r.isDemo });
        const token = await deps.store.issueLink(r.tenantId, r.customerPhone);
        if (!token) {
          result = { outcome: "skipped", error: "no_customer" };
        } else {
          const locale: Loc = r.customerLocale === "en" ? "en" : "ar";
          const mail = renderEmail({
            kind: r.kind,
            locale,
            customerName: r.customerName,
            tenantName: pick(locale, r.tenantNameAr, r.tenantNameEn),
            serviceName: pick(locale, r.serviceNameAr, r.serviceNameEn),
            providerName: pick(locale, r.providerNameAr, r.providerNameEn),
            startsAt: r.startsAt,
            timezone: r.timezone,
            manageUrl: deps.manageUrl(locale, r.tenantSlug, token),
          });
          await provider.send({
            to: r.customerEmail ?? "no-email-on-file@demo.invalid",
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
            tenantId: r.tenantId,
            kind: r.kind,
            sessionHash: r.demoSessionHash,
            idempotencyKey: `reminder-${r.reminderId}-a${r.attempts}`,
          });
          sentVia = provider.name;
          result = { outcome: "sent" };
        }
      }
    } catch (e) {
      const code = e instanceof MailError ? e.code : "unexpected";
      const retryable = e instanceof MailError ? e.retryable : true;
      if (retryable && r.attempts < MAX_ATTEMPTS) {
        result = {
          outcome: "retry",
          error: code,
          retryAt: new Date(now().getTime() + retryDelayMinutes(r.attempts) * 60_000),
        };
      } else {
        result = { outcome: "failed", error: code };
      }
    }

    try {
      await deps.store.complete(r.reminderId, result);
    } catch {
      // the row stays "sending" and is reclaimed after 10 minutes
    }
    if (result.outcome === "sent") sum.sent++;
    else if (result.outcome === "retry") sum.retried++;
    else if (result.outcome === "failed") sum.failed++;
    else sum.skipped++;
    if (sentVia === "resend" && deps.delayMs) await sleep(deps.delayMs);
  }
  return sum;
}
