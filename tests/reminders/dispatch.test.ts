import { describe, expect, it, vi } from "vitest";
import {
  dispatchDueReminders,
  type ClaimedReminder,
  type CompleteOutcome,
  type ReminderStore,
} from "@/lib/reminders/dispatch";
import { MAX_ATTEMPTS, retryDelayMinutes } from "@/lib/reminders/policy";
import { MailError, type MailMessage, type MailProvider } from "@/lib/mail/types";
import { selectMailProvider } from "@/lib/mail/select";
import { createResendProvider } from "@/lib/mail/resend";
import { escapeHtml, renderEmail } from "@/lib/mail/templates";
import { isAuthorizedCron } from "@/lib/cron/auth";

const NOW = new Date("2030-01-10T10:00:00Z");

function row(over: Partial<ClaimedReminder> = {}): ClaimedReminder {
  return {
    reminderId: "r1",
    kind: "24h",
    attempts: 1,
    tenantId: "t1",
    tenantSlug: "clinic-a",
    tenantNameAr: "عيادة",
    tenantNameEn: "Clinic A",
    timezone: "Asia/Riyadh",
    isDemo: false,
    appointmentId: "a1",
    startsAt: "2030-01-11T10:00:00Z",
    providerNameAr: "د. س",
    providerNameEn: "Dr S",
    serviceNameAr: "كشف",
    serviceNameEn: "Check-up",
    customerId: "c1",
    customerName: "Sara",
    customerPhone: "+966500000001",
    customerEmail: "sara@example.com",
    customerLocale: "en",
    demoSessionHash: null,
    ...over,
  };
}

/** In-memory store with the same contract as claim_due_reminders: a row is handed out once. */
function memoryStore(rows: ClaimedReminder[]) {
  const queue = [...rows];
  const done: Record<string, CompleteOutcome> = {};
  const store: ReminderStore = {
    async claim(limit) {
      await Promise.resolve();
      return queue.splice(0, limit);
    },
    async complete(id, r) {
      done[id] = r;
    },
    async issueLink() {
      return "f".repeat(48);
    },
  };
  return { store, done };
}

function recorder(name: MailProvider["name"] = "resend", fail?: () => Error | null) {
  const sent: MailMessage[] = [];
  const p: MailProvider = {
    name,
    async send(m) {
      const e = fail?.();
      if (e) throw e;
      sent.push(m);
      return { id: "x" };
    },
  };
  return { p, sent };
}

const url = (l: string, s: string, t: string) => `https://app.test/${l}/c/${s}/my/${t}`;

describe("dispatchDueReminders", () => {
  it("sends one bilingual mail per claimed reminder with a fresh manage link, then marks it sent", async () => {
    const { store, done } = memoryStore([row(), row({ reminderId: "r2", customerLocale: "ar", customerEmail: "b@example.com" })]);
    const { p, sent } = recorder();
    const sum = await dispatchDueReminders({ store, providerFor: () => p, manageUrl: url, now: () => NOW });
    expect(sum).toMatchObject({ claimed: 2, sent: 2, failed: 0, retried: 0 });
    expect(done.r1).toEqual({ outcome: "sent" });
    expect(sent).toHaveLength(2);
    expect(sent[0].subject).toContain("Clinic A");
    expect(sent[0].text).toContain(`https://app.test/en/c/clinic-a/my/${"f".repeat(48)}`);
    expect(sent[1].subject).toContain("عيادة"); // Arabic customer gets the Arabic mail
    expect(sent[1].html).toContain('dir="rtl"');
    expect(sent[0].idempotencyKey).toBe("reminder-r1-a1");
  });

  it("two concurrent runs never send the same reminder twice", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ reminderId: `r${i}`, appointmentId: `a${i}` }));
    const { store } = memoryStore(rows);
    const { p, sent } = recorder();
    const deps = { store, providerFor: () => p, manageUrl: url, now: () => NOW, limit: 4 };
    const sums = await Promise.all([dispatchDueReminders(deps), dispatchDueReminders(deps), dispatchDueReminders(deps)]);
    const claimed = sums.reduce((n, s) => n + s.claimed, 0);
    expect(claimed).toBe(10);
    expect(new Set(sent.map((m) => m.idempotencyKey)).size).toBe(sent.length);
    expect(sent).toHaveLength(10);
  });

  it("retries a transient failure with backoff, and stops after MAX_ATTEMPTS", async () => {
    const { store, done } = memoryStore([row({ attempts: 1 })]);
    const { p } = recorder("resend", () => new MailError("resend_503", true));
    await dispatchDueReminders({ store, providerFor: () => p, manageUrl: url, now: () => NOW });
    expect(done.r1).toEqual({
      outcome: "retry",
      error: "resend_503",
      retryAt: new Date(NOW.getTime() + retryDelayMinutes(1) * 60_000),
    });

    const last = memoryStore([row({ attempts: MAX_ATTEMPTS })]);
    await dispatchDueReminders({ store: last.store, providerFor: () => p, manageUrl: url, now: () => NOW });
    expect(last.done.r1).toEqual({ outcome: "failed", error: "resend_503" });
  });

  it("does not retry a permanent failure (4xx)", async () => {
    const { store, done } = memoryStore([row({ attempts: 1 })]);
    const { p } = recorder("resend", () => new MailError("resend_403", false));
    const sum = await dispatchDueReminders({ store, providerFor: () => p, manageUrl: url, now: () => NOW });
    expect(done.r1).toEqual({ outcome: "failed", error: "resend_403" });
    expect(sum.failed).toBe(1);
  });

  it("backoff grows and is capped", () => {
    expect([1, 2, 3, 4].map(retryDelayMinutes)).toEqual([5, 15, 45, 135]);
    expect(retryDelayMinutes(10)).toBe(360);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(5);
  });

  it("an unconfigured provider is a retryable failure, not a crash of the whole run", async () => {
    const { store, done } = memoryStore([row(), row({ reminderId: "r2", appointmentId: "a2" })]);
    const sum = await dispatchDueReminders({
      store,
      providerFor: () => {
        throw new MailError("mail_not_configured", true);
      },
      manageUrl: url,
      now: () => NOW,
    });
    expect(sum.retried).toBe(2);
    expect(done.r1).toMatchObject({ outcome: "retry", error: "mail_not_configured" });
  });

  it("skips customers without an e-mail (real tenant) and seeded demo data without a visitor session", async () => {
    const { store, done } = memoryStore([
      row({ reminderId: "n1", customerEmail: null }),
      row({ reminderId: "d1", isDemo: true, demoSessionHash: null }),
    ]);
    const { p, sent } = recorder();
    await dispatchDueReminders({ store, providerFor: () => p, manageUrl: url, now: () => NOW });
    expect(sent).toHaveLength(0);
    expect(done.n1).toEqual({ outcome: "skipped", error: "no_email" });
    expect(done.d1).toEqual({ outcome: "skipped", error: "no_demo_session" });
  });

  it("skips (never mails) when the customer no longer exists", async () => {
    const { store, done } = memoryStore([row()]);
    store.issueLink = async () => null;
    const { p, sent } = recorder();
    await dispatchDueReminders({ store, providerFor: () => p, manageUrl: url, now: () => NOW });
    expect(sent).toHaveLength(0);
    expect(done.r1).toEqual({ outcome: "skipped", error: "no_customer" });
  });

  it("paces real sends but not the demo outbox", async () => {
    const sleep = vi.fn(async () => {});
    const a = memoryStore([row(), row({ reminderId: "r2" })]);
    await dispatchDueReminders({ store: a.store, providerFor: () => recorder("resend").p, manageUrl: url, delayMs: 600, sleep });
    expect(sleep).toHaveBeenCalledTimes(2);
    sleep.mockClear();
    const b = memoryStore([row({ isDemo: true, demoSessionHash: "a".repeat(64) })]);
    await dispatchDueReminders({ store: b.store, providerFor: () => recorder("outbox").p, manageUrl: url, delayMs: 600, sleep });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("mail provider selection", () => {
  it("demo tenants NEVER reach Resend, even with MAIL_PROVIDER=resend and a key", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const outboxWriter = vi.fn(async () => {});
    const p = selectMailProvider(
      { is_demo: true },
      { MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_live_key" },
      { outboxWriter, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(p.name).toBe("outbox");
    await p.send({ to: "a@b.co", subject: "s", text: "t", html: "<p>t</p>", tenantId: "t1", kind: "2h", sessionHash: "a".repeat(64) });
    expect(outboxWriter).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("the full dispatcher keeps demo reminders away from Resend", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const outboxWriter = vi.fn(async () => {});
    const { store, done } = memoryStore([row({ isDemo: true, demoSessionHash: "b".repeat(64), customerEmail: "v@example.com" })]);
    await dispatchDueReminders({
      store,
      manageUrl: url,
      providerFor: (t) =>
        selectMailProvider(t, { MAIL_PROVIDER: "resend", RESEND_API_KEY: "k" }, { outboxWriter, fetchImpl: fetchImpl as unknown as typeof fetch }),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outboxWriter).toHaveBeenCalledWith(expect.objectContaining({ sessionHash: "b".repeat(64), tenantId: "t1" }));
    expect(done.r1).toEqual({ outcome: "sent" });
  });

  it("real tenants use Resend only when configured; otherwise they fail closed", () => {
    const deps = { outboxWriter: async () => {} };
    expect(selectMailProvider({ is_demo: false }, { MAIL_PROVIDER: "resend", RESEND_API_KEY: "k" }, deps).name).toBe("resend");
    for (const env of [{}, { MAIL_PROVIDER: "outbox" }, { MAIL_PROVIDER: "resend" }, { MAIL_PROVIDER: "x", RESEND_API_KEY: "k" }]) {
      expect(() => selectMailProvider({ is_demo: false }, env, deps)).toThrow(MailError);
    }
  });

  it("the outbox provider refuses a message without a visitor session", async () => {
    const p = selectMailProvider({ is_demo: true }, {}, { outboxWriter: async () => {} });
    await expect(p.send({ to: "a@b.co", subject: "s", text: "t", html: "h", tenantId: "t", kind: "link" })).rejects.toThrow("no_session");
  });
});

describe("Resend provider (plain fetch)", () => {
  const msg: MailMessage = { to: "a@b.co", subject: "Hi", text: "t", html: "<p>t</p>", tenantId: "t", kind: "2h", idempotencyKey: "k1" };

  it("POSTs to api.resend.com/emails with a Bearer key and the idempotency header", async () => {
    const fetchImpl = vi.fn(async (...args: [string, RequestInit]) => { void args; return new Response(JSON.stringify({ id: "mail_1" }), { status: 200 }); });
    const p = createResendProvider({ apiKey: "re_key", from: "Dawrak <x@d.com>", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await p.send(msg)).toEqual({ id: "mail_1" });
    const [u, init] = fetchImpl.mock.calls[0];
    expect(u).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer re_key");
    expect(h["Idempotency-Key"]).toBe("k1");
    expect(JSON.parse(init.body as string)).toEqual({ from: "Dawrak <x@d.com>", to: ["a@b.co"], subject: "Hi", html: "<p>t</p>", text: "t" });
  });

  it("classifies errors: 429 and 5xx retry, other 4xx never, and the recipient is not echoed", async () => {
    const mk = (status: number) =>
      createResendProvider({ apiKey: "k", from: "f", fetchImpl: (async () => new Response('{"message":"to a@b.co"}', { status })) as unknown as typeof fetch });
    await expect(mk(429).send(msg)).rejects.toMatchObject({ code: "resend_429", retryable: true });
    await expect(mk(503).send(msg)).rejects.toMatchObject({ code: "resend_503", retryable: true });
    await expect(mk(403).send(msg)).rejects.toMatchObject({ code: "resend_403", retryable: false });
    await expect(mk(422).send(msg)).rejects.toSatisfy((e: Error) => !e.message.includes("a@b.co"));
    const net = createResendProvider({ apiKey: "k", from: "f", fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    await expect(net.send(msg)).rejects.toMatchObject({ code: "network", retryable: true });
  });
});

describe("cron authorization", () => {
  const SECRET = "s".repeat(32);
  it("accepts only the exact Bearer secret", () => {
    expect(isAuthorizedCron(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isAuthorizedCron(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isAuthorizedCron(`Bearer ${SECRET.slice(1)}`, SECRET)).toBe(false);
    expect(isAuthorizedCron(SECRET, SECRET)).toBe(false);
    expect(isAuthorizedCron(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorizedCron(null, SECRET)).toBe(false);
    expect(isAuthorizedCron("", SECRET)).toBe(false);
  });
  it("fails closed when the secret is unset, empty or too short, even if the header matches", () => {
    for (const s of [undefined, "", "short"]) {
      expect(isAuthorizedCron(`Bearer ${s ?? ""}`, s)).toBe(false);
      expect(isAuthorizedCron("Bearer undefined", s)).toBe(false);
      expect(isAuthorizedCron("Bearer ", s)).toBe(false);
    }
  });
});

describe("e-mail templates", () => {
  const base = {
    kind: "24h" as const,
    locale: "en" as const,
    customerName: "Sara",
    tenantName: "Clinic A",
    serviceName: "Check-up",
    providerName: "Dr S",
    startsAt: "2030-01-11T10:00:00Z",
    timezone: "Asia/Riyadh",
    manageUrl: "https://app.test/en/c/a/my/" + "f".repeat(48),
  };

  it("escapes user-provided names in the HTML and never injects markup or header breaks", () => {
    const evil = `<img src=x onerror=alert(1)>"&'\r\nBcc: evil@x.com`;
    const m = renderEmail({ ...base, customerName: evil, tenantName: evil, serviceName: evil, providerName: evil });
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(m.html).not.toMatch(/onerror=alert\(1\)>/);
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(escapeHtml(`a"b'c<d>&`)).toBe("a&quot;b&#39;c&lt;d&gt;&amp;");
  });

  it("shows Gregorian and Hijri date and the time in the tenant timezone, in both languages", () => {
    const en = renderEmail(base);
    expect(en.text).toContain("January 11, 2030");
    expect(en.text).toMatch(/1:00 PM/); // 10:00Z is 13:00 in Riyadh
    expect(en.text).toMatch(/Hijri: .*14\d\d/);
    const ar = renderEmail({ ...base, locale: "ar" });
    expect(ar.text).toMatch(/[٠-٩]/);
    expect(ar.text).toContain("التاريخ الهجري");
    expect(ar.html).toContain('lang="ar" dir="rtl"');
    expect(ar.subject).toContain("تذكير");
  });

  it("has a manage link, plain HTML only: no images, scripts or external resources", () => {
    const m = renderEmail(base);
    expect(m.text).toContain(base.manageUrl);
    expect(m.html).toContain(`href="${base.manageUrl}"`);
    expect(m.html).not.toMatch(/<(img|script|link|iframe|style)\b/i);
    expect(m.html).not.toMatch(/src=/i);
  });

  it("the link mail carries no appointment details", () => {
    const m = renderEmail({ ...base, kind: "link", startsAt: undefined, serviceName: undefined, providerName: undefined });
    expect(m.text).not.toContain("Check-up");
    expect(m.text).toContain(base.manageUrl);
  });
});
