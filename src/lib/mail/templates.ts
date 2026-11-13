import { dateKeyInZone, formatGregorian, formatHijri, formatTime, type Loc } from "@/components/booking/dates";
import type { MailKind } from "./types";

export type EmailInput = {
  kind: MailKind;
  locale: Loc;
  customerName: string;
  tenantName: string;
  /** not used by the "link" mail */
  serviceName?: string;
  providerName?: string;
  startsAt?: string;
  timezone: string;
  /** Absolute link to the patient page (contains the secret token: it appears only in the mail body). */
  manageUrl: string;
  /** booking mail only */
  awaitingDeposit?: boolean;
};

export type RenderedEmail = { subject: string; text: string; html: string };

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** One line, no control characters (a name must never be able to inject headers or break the subject). */
export function oneLine(s: string, max = 120): string {
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const COPY = {
  en: {
    subject: {
      "24h": (c: string) => `Reminder: your appointment tomorrow at ${c}`,
      "2h": (c: string) => `Reminder: your appointment in 2 hours at ${c}`,
      booking: (c: string) => `Your booking at ${c}`,
      link: (c: string) => `Your link to manage your appointments at ${c}`,
    },
    hello: (n: string) => `Hello ${n},`,
    lead: {
      "24h": "This is a reminder of your appointment tomorrow.",
      "2h": "This is a reminder: your appointment starts in about 2 hours.",
      booking: "Thank you for booking. Here are the details.",
      booking_pending: "We are holding your appointment. Pay the deposit within 15 minutes to confirm it.",
      link: "You asked for a link to manage your appointments.",
    },
    clinic: "Clinic",
    service: "Service",
    provider: "With",
    when: "When",
    hijri: "Hijri",
    manage: "Cancel or reschedule your appointment:",
    manageNote: "Changes are possible until 2 hours before the start. Do not forward this link: anyone who has it can manage your appointments.",
    footer: "You received this e-mail because of a booking made with your contact details.",
  },
  ar: {
    subject: {
      "24h": (c: string) => `تذكير: موعدك غداً في ${c}`,
      "2h": (c: string) => `تذكير: موعدك بعد ساعتين في ${c}`,
      booking: (c: string) => `حجزك في ${c}`,
      link: (c: string) => `رابط إدارة مواعيدك في ${c}`,
    },
    hello: (n: string) => `مرحباً ${n}،`,
    lead: {
      "24h": "هذا تذكير بموعدك غداً.",
      "2h": "هذا تذكير: يبدأ موعدك بعد ساعتين تقريباً.",
      booking: "شكراً لحجزك. هذه تفاصيل الموعد.",
      booking_pending: "نحجز لك الموعد مؤقتاً. ادفع العربون خلال 15 دقيقة لتأكيده.",
      link: "طلبت رابطاً لإدارة مواعيدك.",
    },
    clinic: "المكان",
    service: "الخدمة",
    provider: "مع",
    when: "الموعد",
    hijri: "التاريخ الهجري",
    manage: "لإلغاء الموعد أو تغييره:",
    manageNote: "يمكنك التعديل حتى ساعتين قبل الموعد. لا تشارك هذا الرابط: أي شخص يملكه يستطيع إدارة مواعيدك.",
    footer: "وصلتك هذه الرسالة بسبب حجز تم ببيانات التواصل الخاصة بك.",
  },
} as const;

/**
 * Plain HTML + text, Gregorian and Hijri date in the tenant's timezone. Every user-supplied value is
 * escaped in the HTML; there are no images, no tracking pixels and no external resources.
 */
export function renderEmail(i: EmailInput): RenderedEmail {
  const c = COPY[i.locale];
  const tenant = oneLine(i.tenantName);
  const subject = oneLine(c.subject[i.kind](tenant), 200);
  const leadKey = i.kind === "booking" && i.awaitingDeposit ? "booking_pending" : i.kind;
  const lead = c.lead[leadKey];
  const rows: [string, string][] = [[c.clinic, tenant]];
  if (i.kind !== "link" && i.startsAt) {
    const dateKey = dateKeyInZone(i.startsAt, i.timezone);
    const greg = formatGregorian(dateKey, i.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    rows.push(
      [c.service, oneLine(i.serviceName ?? "")],
      [c.provider, oneLine(i.providerName ?? "")],
      [c.when, `${greg} - ${formatTime(i.startsAt, i.timezone, i.locale)}`],
      [c.hijri, formatHijri(dateKey, undefined, i.locale)],
    );
  }
  const name = oneLine(i.customerName, 100);

  const text = [
    c.hello(name),
    "",
    lead,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    c.manage,
    i.manageUrl,
    "",
    c.manageNote,
    "",
    c.footer,
    "",
  ].join("\n");

  const dir = i.locale === "ar" ? "rtl" : "ltr";
  const align = i.locale === "ar" ? "right" : "left";
  const tr = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top">${escapeHtml(k)}</td><td style="padding:4px 0;font-weight:600">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  const html =
    `<!doctype html><html lang="${i.locale}" dir="${dir}"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;color:#111;background:#fff;text-align:${align}">` +
    `<div style="max-width:520px;margin:0 auto" dir="${dir}">` +
    `<p>${escapeHtml(c.hello(name))}</p><p>${escapeHtml(lead)}</p>` +
    `<table role="presentation" style="border-collapse:collapse;margin:12px 0">${tr}</table>` +
    `<p>${escapeHtml(c.manage)}<br><a href="${escapeHtml(i.manageUrl)}">${escapeHtml(i.manageUrl)}</a></p>` +
    `<p style="color:#555;font-size:13px">${escapeHtml(c.manageNote)}</p>` +
    `<p style="color:#777;font-size:12px">${escapeHtml(c.footer)}</p>` +
    `</div></body></html>`;
  return { subject, text, html };
}
