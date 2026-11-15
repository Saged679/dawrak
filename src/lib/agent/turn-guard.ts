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
  /** Server-built summaries (prepare_* results) shown to the visitor this turn. */
  readonly summaries: string[] = [];
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
  /** A prepare_ tool succeeded in this turn: the visitor only saw a summary, nothing was done. */
  preparedOk(): boolean {
    return this.events.some((e) => e.kind === "ok" && e.tool.startsWith("prepare_"));
  }
  bookingAttemptFailed(): boolean {
    return this.unresolved(BOOKING_TOOLS).length > 0;
  }
  /** A mutating tool was called in this turn (any outcome). */
  mutationAttempted(): boolean {
    return this.events.some((e) => (BOOKING_TOOLS as readonly string[]).includes(e.tool));
  }
  /** The LAST mutating call of the turn did not return ok (refused, failed or rejected input): nothing was changed by it. */
  lastMutationFailed(): boolean {
    const last = this.events.filter((e) => (BOOKING_TOOLS as readonly string[]).includes(e.tool)).at(-1);
    return !!last && last.kind !== "ok";
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
  /تم\s+(ال)?(حجز|تأكيد\s+(ال)?(حجز|موعد)|إلغاء|الغاء|تعديل\s+(ال)?(حجز|موعد)|نقل\s+(ال)?(حجز|موعد))[؀-ۿ]*/,
  /(تم|جرى)\s+(حجز|تثبيت|تسجيل)\s+(موعد|الحجز)/,
  /(حجزت|ثبّت|ثبتّ|ثبتت|أكدت|ألغيت|الغيت)\s+(لك|ل?ك\s+)?(ال)?(موعد|حجز)/,
  /(موعدك|حجزك)\s+(تم\s+)?(مؤكد|تأكد|تثبت|اتحجز|انحجز|تم\s+حجزه)/,
  /\bI(?:'ve|\s+have)\s+(?:successfully\s+)?(booked|cancelled|canceled|rescheduled|confirmed)\b/i,
  /\byour\s+(appointment|booking)\s+(is|has\s+been|was)\s+(now\s+)?(successfully\s+)?(confirmed|booked|cancelled|canceled|rescheduled|set)\b/i,
  /\b(appointment|booking)\s+(is\s+)?(now\s+)?(confirmed|booked)\b/i,
];
export const claimsActionDone = (t: string) => DONE_CLAIM.some((r) => r.test(t));

/**
 * Broader wording used ONLY when the last mutating tool of the turn did not succeed (so any "done" talk is
 * false): the narrow patterns above plus a bare "تم" / "بنجاح" / "successfully" / "done".
 */
const LOOSE_CLAIM = [/(?<![؀-ۿ])تم(?![؀-ۿ])/, /بنجاح/, /\bsuccessfully\b/i, /\b(all\s+set|done)\b/i];
export const claimsSuccessLoosely = (t: string) => claimsActionDone(t) || LOOSE_CLAIM.some((r) => r.test(t));

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
 *     was rejected (and nobody fixed it afterwards), or a prepare_ tool only produced a summary: replaced by an honest correction. The failed attempt
 *     is the signal that makes this safe; without any attempt in the turn the claim may be about an
 *     earlier booking ("did my booking go through?"), so only the prompt guards that case.
 *  2. A "technical problem" apology that came from an unresolved input-validation failure: replaced by a
 *     neutral, factual note, so the recoverable error is not recorded as an outage.
 */
export function guardReply(text: string, turn: TurnState): GuardOutcome {
  const ar = isArabicText(text);
  const lang = ar ? "ar" : "en";
  // The LAST mutating call of the turn did not return ok: nothing was changed, so no success wording may stand.
  if (!turn.bookingSucceeded() && turn.lastMutationFailed() && claimsSuccessLoosely(text)) {
    return { text: NOT_DONE[lang], changed: "claim_replaced" };
  }
  if (!turn.bookingSucceeded() && (turn.bookingAttemptFailed() || turn.preparedOk()) && claimsActionDone(text)) {
    return { text: NOT_DONE[lang], changed: "claim_replaced" };
  }
  if (turn.hasInvalidUnresolved() && looksLikeTechnicalApology(text)) {
    return { text: NEEDS_REVIEW[lang], changed: "apology_replaced" };
  }
  return { text, changed: "none" };
}

/** Token-shaped strings (base64url body "." 43-character signature) never reach storage or the dashboard. */
export function redactTokens(text: string): string {
  return text.replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{30,}/g, "[removed]");
}

const toLatinDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

/** Clock times (minutes since midnight) and money amounts mentioned in a text. */
function figures(raw: string): { times: Set<number>; amounts: Set<number> } {
  const s = toLatinDigits(raw);
  const times = new Set<number>();
  for (const m of s.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|ص|م)?(?![\d:])/gi)) {
    const hasColon = m[2] !== undefined;
    const suffix = m[3]?.toLowerCase();
    if (!hasColon && !suffix) continue; // a bare number is not a time
    let h = Number(m[1]);
    const min = hasColon ? Number(m[2]) : 0;
    if (suffix) {
      const pm = suffix === "pm" || suffix === "p.m." || suffix === "م";
      if (h < 1 || h > 12) continue;
      h = (h % 12) + (pm ? 12 : 0);
    }
    if (h <= 23 && min <= 59) times.add(h * 60 + min);
  }
  const amounts = new Set<number>();
  for (const m of s.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:sar|riyals?|ريال|ر\.س|﷼)/gi)) amounts.add(Number(m[1].replace(",", ".")));
  return { times, amounts };
}

const NEUTRAL = {
  ar: "راجع الملخص أعلاه، ثم اضغط تأكيد للحجز أو تعديل لتغيير أي شيء.",
  en: "Please review the summary above, then tap Confirm to book or Change to edit anything.",
} as const;

/**
 * After a successful prepare_* the visitor sees the SERVER's summary. If the model's own text names a clock time
 * or a price that the summary does not contain ("booked for free at 9am"), it contradicts what will happen, so it
 * is replaced by a fixed neutral sentence. Deliberately narrow: only HH:mm / 9am style times and amounts with a
 * currency word are compared; dates and other wording are not (a stricter check would flag legitimate text).
 */
export function guardPrepareText(text: string, summary: string): string {
  const lang = isArabicText(summary) ? "ar" : "en";
  if (!text.trim()) return NEUTRAL[lang];
  const mine = figures(text);
  const server = figures(summary);
  const conflict = [...mine.times].some((t) => !server.times.has(t)) || [...mine.amounts].some((a) => !server.amounts.has(a));
  return conflict ? NEUTRAL[lang] : text;
}

type Chunk = { type: string; id?: string; text?: string };

/**
 * Streaming side of the false-success guard. Text is HELD (per text part) in turns where a mutating or prepare_ tool
 * exists or may come (`confirmable`: the visitor's message confirms a pending action) and released at the end of
 * the model step, when the tool outcomes of that step are known, corrected when it claims success although no
 * mutating call succeeded and the last one did not return ok. This also covers text written BEFORE a tool call in
 * the same step. Other turns (questions, availability) stream untouched, token by token.
 */
export function claimGuardTransform(turn: TurnState, opts: { confirmable?: boolean } = {}) {
  return () => {
    const held = new Map<string, { start: Chunk; text: string; ended: boolean }>();
    const flush = (controller: TransformStreamDefaultController<Chunk>) => {
      for (const [id, b] of held) {
        const text = guardReply(b.text, turn).text;
        controller.enqueue(b.start);
        if (text) controller.enqueue({ type: "text-delta", id, text });
        controller.enqueue({ type: "text-end", id });
      }
      held.clear();
    };
    return new TransformStream<Chunk, Chunk>({
      transform(chunk, controller) {
        const id = chunk.id ?? "";
        if (chunk.type === "text-start" && (opts.confirmable || turn.mutationAttempted() || turn.preparedOk())) {
          held.set(id, { start: chunk, text: "", ended: false });
          return;
        }
        const b = held.get(id);
        if (b && chunk.type === "text-delta") {
          b.text += chunk.text ?? "";
          return;
        }
        if (b && chunk.type === "text-end") {
          b.ended = true;
          return;
        }
        if (chunk.type === "finish-step" || chunk.type === "finish") flush(controller);
        controller.enqueue(chunk);
      },
      flush(controller) {
        flush(controller);
      },
    });
  };
}
