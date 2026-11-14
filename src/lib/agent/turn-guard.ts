/**
 * Per-turn bookkeeping and the rules for what may be PERSISTED as the assistant's reply.
 *
 * The text already streamed to the visitor cannot be changed afterwards; what these rules protect is the
 * stored history (the model reads it next turn, staff read it in the dashboard).
 */

export const BOOKING_TOOLS = ["create_booking", "reschedule_booking", "cancel_booking"] as const;

export type ToolEvent = { tool: string; kind: "ok" | "fail" | "invalid" };

export class TurnState {
  readonly events: ToolEvent[] = [];
  record(tool: string, kind: ToolEvent["kind"]) {
    this.events.push({ tool, kind });
  }
  /** Result objects of our tools are `{ ok: true | false, ... }`. */
  recordResult(tool: string, result: unknown) {
    this.record(tool, (result as { ok?: unknown } | null)?.ok === true ? "ok" : "fail");
  }
  /** Tools whose LAST event is not a success (invalid input, or an error result nobody fixed afterwards). */
  unresolved(tools?: readonly string[]): ToolEvent[] {
    const last = new Map<string, ToolEvent>();
    for (const e of this.events) last.set(e.tool, e);
    return [...last.values()].filter((e) => e.kind !== "ok" && (!tools || tools.includes(e.tool)));
  }
  hasInvalidUnresolved(): boolean {
    return this.unresolved().some((e) => e.kind === "invalid");
  }
  bookingSucceeded(): boolean {
    return this.events.some((e) => e.kind === "ok" && (BOOKING_TOOLS as readonly string[]).includes(e.tool));
  }
  bookingAttemptFailed(): boolean {
    return this.unresolved(BOOKING_TOOLS).length > 0;
  }
}

const AR = /[؀-ۿ]/;
export const isArabicText = (t: string) => AR.test(t);

/** "technical problem" style apologies, Arabic and English. */
const TECH_APOLOGY = [
  /مشكل[ةه]\s+(تقني|فني)/,
  /(خطأ|عطل|خلل)\s+(تقني|فني)/,
  /مشكل[ةه]\s+في\s+(ال)?(نظام|خدم[ةه])/,
  /\btechnical\s+(problem|issue|difficult|error|glitch|hiccup)/i,
  /\bsystem\s+(error|issue|problem)/i,
  /\bsomething\s+went\s+wrong\b/i,
  /\bencountered\s+an?\s+(error|issue|problem)\b/i,
];
export const looksLikeTechnicalApology = (t: string) => TECH_APOLOGY.some((r) => r.test(t));

/**
 * Past-tense "it is done" wording for a booking, a cancellation or a move. Deliberately narrow: these are
 * statements of a completed fact, not offers ("هل تريد أن أحجز"), summaries ("سأحجز") or questions.
 * Arabic and English only; a language we do not match simply is not guarded (no false positives).
 */
const DONE_CLAIM = [
  /تم\s+(ال)?(حجز|تأكيد\s+(ال)?(حجز|موعد)|إلغاء|الغاء|تعديل\s+(ال)?(حجز|موعد)|نقل\s+(ال)?(حجز|موعد))/,
  /(تم|جرى)\s+(حجز|تثبيت|تسجيل)\s+(موعد|الحجز)/,
  /(حجزت|ثبّت|ثبتّ|ثبتت|أكدت|ألغيت|الغيت)\s+(لك|ل?ك\s+)?(ال)?(موعد|حجز)/,
  /(موعدك|حجزك)\s+(تم\s+)?(مؤكد|تأكد|تثبت|اتحجز|انحجز|تم\s+حجزه)/,
  /\bI(?:'ve|\s+have)\s+(?:successfully\s+)?(booked|cancelled|canceled|rescheduled|confirmed)\b/i,
  /\byour\s+(appointment|booking)\s+(is|has\s+been|was)\s+(now\s+)?(successfully\s+)?(confirmed|booked|cancelled|canceled|rescheduled|set)\b/i,
  /\b(appointment|booking)\s+(is\s+)?(now\s+)?(confirmed|booked)\b/i,
];
export const claimsActionDone = (t: string) => DONE_CLAIM.some((r) => r.test(t));

const NOT_DONE = {
  ar: "لم يتم تنفيذ الطلب بعد، ولم يُحجز أو يُعدّل أو يُلغَ أي موعد. هل تؤكد التفاصيل مرة ثانية لأحاول من جديد؟",
  en: "That has not gone through yet: no appointment was booked, changed or cancelled. Could you confirm the details once more so I can try again?",
} as const;

const NEEDS_REVIEW = {
  ar: "لم يكتمل الإجراء بعد لأن بعض التفاصيل تحتاج مراجعة. لم يُحجز أو يُعدّل أو يُلغَ أي شيء حتى الآن.",
  en: "That did not complete yet because some details need another look. Nothing has been booked, changed or cancelled so far.",
} as const;

export type GuardOutcome = { text: string; changed: "none" | "apology_replaced" | "claim_replaced" };

/**
 * What to store as the assistant's final message for this turn.
 *  1. A booking-confirmation claim while no booking tool succeeded in the turn AND a booking tool failed or
 *     was rejected (and nobody fixed it afterwards): replaced by an honest correction. The failed attempt
 *     is the signal that makes this safe; without any attempt in the turn the claim may be about an
 *     earlier booking ("did my booking go through?"), so only the prompt guards that case.
 *  2. A "technical problem" apology that came from an unresolved input-validation failure: replaced by a
 *     neutral, factual note, so the recoverable error is not recorded as an outage.
 */
export function guardReply(text: string, turn: TurnState): GuardOutcome {
  const ar = isArabicText(text);
  const lang = ar ? "ar" : "en";
  if (!turn.bookingSucceeded() && turn.bookingAttemptFailed() && claimsActionDone(text)) {
    return { text: NOT_DONE[lang], changed: "claim_replaced" };
  }
  if (turn.hasInvalidUnresolved() && looksLikeTechnicalApology(text)) {
    return { text: NEEDS_REVIEW[lang], changed: "apology_replaced" };
  }
  return { text, changed: "none" };
}
