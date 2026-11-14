/**
 * Is this visitor message an explicit, plain "yes, go ahead"?
 *
 * This is the SERVER-side gate behind every mutating chat tool, so it is deliberately a WHITELIST: the
 * message counts only when it is short and EVERY word is a known affirmative or a harmless polite filler.
 * Anything else is "not confirmed": negations ("لا", "no", "مو"), hedges and conditionals ("ايوه بس", "ok لو",
 * "wait"), questions, new information ("ايوه الساعة 5"), unknown dialect words, mixed sentences.
 *
 * Words come in three kinds:
 *  - STRONG: explicit consent on their own (تأكيد، أكد، نعم، ايوه، احجز، yes، confirm، book...).
 *  - WEAK: acknowledgements that mean "ok" only when nothing else is said (تمام، ok، okay، موافق، ماشي...).
 *    They count alone or with polite fillers ("تمام شكرا", "ok thanks"), or next to a strong word.
 *  - POLITE fillers (شكرا، من فضلك، please, thanks, it, the booking...). They never confirm anything alone.
 * Cancellation words are fillers ONLY when the pending action is a cancellation: "تمام الغاء الحجز" must not
 * confirm a booking.
 *
 * Pure function, no I/O. `locale` is accepted for API stability; the lexicon is the same for every locale
 * (visitors mix languages).
 */

export type AffirmativeAction = "create_booking" | "reschedule_booking" | "cancel_booking";

const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const MAX_WORDS = 7;

const STRONG = new Set([
  // Arabic (MSA, Gulf, Egyptian, Levantine), normalised: no diacritics, alef/ya/ta-marbuta unified
  "نعم", "ايوه", "ايوا", "ايو", "اكيد", "اكد", "تاكيد", "اوكد", "اجل",
  // English
  "yes", "yeah", "yea", "yep", "yup", "yas", "confirm", "confirmed", "confirmation", "proceed", "ahead", "absolutely", "definitely", "affirmative",
  "__yes_emoji__",
]);

const WEAK = new Set([
  "تمام", "موافق", "موافقه", "ماشي", "يلا", "ياله", "يالله", "ابشر", "زين", "حسنا", "اوكي", "اوكيه",
  "ok", "okay", "okey", "sure", "alright", "agreed",
]);

/** Polite or neutral words that add no information. None of them confirms anything on its own. */
const POLITE = new Set([
  "و", "من", "فضلك", "فضلكم", "سمحت", "لوسمحت", "شكرا", "طيب", "طيبه",
  "it", "the", "a", "go", "please", "pls", "plz", "thanks", "thank", "you", "for", "me", "that", "thats", "this",
]);

/**
 * Booking and appointment words. They confirm / are polite fillers only for a booking or a reschedule: next to a
 * CANCEL summary they are unknown words, so "احجز الموعد", "اكد الحجز", "book it", "confirm the booking" never
 * confirm a cancellation. (The exact quick-reply "تأكيد" / "Confirm" has none of them and stays valid.)
 */
const BOOKING_STRONG = new Set(["احجز", "احجزه", "احجزي", "book"]);
const BOOKING_POLITE = new Set(["الحجز", "حجز", "موعد", "الموعد", "booking", "appointment"]);

/** Cancellation words: polite fillers ONLY while confirming a cancellation (never for a booking or a move). */
const CANCEL_ONLY = new Set(["الغاء", "الالغاء", "الغي", "الغيه", "الغيها", "الغ", "cancel", "cancellation", "cancelled", "canceled"]);

const SEPARATOR = /[^\p{L}\p{N}_]+/gu;

function normalizeAr(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(DIACRITICS, "")
    .replace(TATWEEL, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

const YES_EMOJI = /[\u{1F44D}\u{1F44C}\u{2705}\u{2714}\u{1F197}\u{1F4AF}]️?[\u{1F3FB}-\u{1F3FF}]?/gu;
const NO_EMOJI = /[\u{1F44E}\u{274C}\u{1F6AB}\u{26D4}\u{1F645}\u{270B}\u{1F44B}\u{1F937}\u{1F914}\u{1F64F}\u{1F91D}]️?[\u{1F3FB}-\u{1F3FF}]?/gu;

/** Candidate spellings of a word with stretched letters: "ايوووه", "yesss", "okkk". */
function candidates(word: string): string[] {
  const out = [word];
  const three = word.replace(/(.)\1{2,}/gu, "$1$1");
  if (three !== word) out.push(three);
  const one = word.replace(/(.)\1+/gu, "$1");
  if (one !== three && one !== word) out.push(one);
  return out;
}

export function isAffirmative(text: string, locale?: "ar" | "en", action?: AffirmativeAction): boolean {
  void locale;
  if (typeof text !== "string") return false;
  if (text.length > 120) return false; // a long message always carries information
  if (/[?؟]/.test(text)) return false; // a question is not a confirmation
  // Emoji other than plain thumbs-up / check marks (prayer hands, handshake, shrug...) are ambiguous: not consent.
  if (NO_EMOJI.test(text)) {
    NO_EMOJI.lastIndex = 0;
    return false;
  }
  NO_EMOJI.lastIndex = 0;
  // Any pictograph other than the plain thumbs-up / check marks (sarcastic "🙄👍", "😂 ok") means not confirmed.
  if (/\p{Extended_Pictographic}/u.test(text.replace(YES_EMOJI, ""))) return false;
  // Combining or strike-through marks ("yes\u0336") are an attempt to look like a word: reject (Arabic diacritics are fine).
  if (/\p{M}/u.test(text.normalize("NFKC").replace(DIACRITICS, "").replace(/\uFE0F/g, ""))) return false;

  const words = normalizeAr(text.replace(YES_EMOJI, " __yes_emoji__ "))
    .replace(/['’`´]/g, "")
    .split(SEPARATOR)
    .filter(Boolean);
  if (words.length === 0 || words.length > MAX_WORDS) return false;

  let strong = false;
  let weakCount = 0;
  const seen = new Map<string, number>();
  for (const w of words) {
    const cands = candidates(w);
    // one word at most twice ("اوكي" x7 is not consent)
    const n = (seen.get(cands[cands.length - 1]) ?? 0) + 1;
    seen.set(cands[cands.length - 1], n);
    if (n > 2) return false;
    const booking = action !== "cancel_booking";
    if (cands.some((c) => STRONG.has(c) || (booking && BOOKING_STRONG.has(c)))) strong = true;
    else if (cands.some((c) => WEAK.has(c))) weakCount++;
    else if (cands.some((c) => POLITE.has(c) || (booking && BOOKING_POLITE.has(c)))) continue;
    else if (action === "cancel_booking" && cands.some((c) => CANCEL_ONLY.has(c))) continue;
    else return false; // unknown word: negation, hedge, conditional, new information, other dialect...
  }
  // acknowledgements alone ("تمام", "ok thanks") count; a pile of them does not
  return strong || (weakCount >= 1 && weakCount <= 2);
}
