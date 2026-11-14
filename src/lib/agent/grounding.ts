import { normalizeText } from "./lexical";

/**
 * Grounding of personal data. A customer's name, phone and email may only be used for a booking when they
 * appear in the VISITOR'S OWN typed messages of this conversation. The model must never invent them (it did:
 * "test@example.com"). Voice notes cannot ground text values (the audio is not kept and transcription by the
 * model is unreliable for names and digits): the visitor has to type them.
 */

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

export const toLatinDigits = (s: string) =>
  s
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)));

/**
 * Canonical key of a phone number: digits only, without 00 / + international prefix and without the Saudi
 * country code or trunk 0, so +966501234567, 00966501234567, 966501234567, 0501234567 and 501234567 match.
 */
export function phoneKey(raw: string): string {
  let d = toLatinDigits(raw).replace(/\D+/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("966")) d = d.slice(3);
  d = d.replace(/^0+/, "");
  return d;
}

/** Dates and clock times typed next to a number must not be glued onto it. */
const DATE_OR_TIME = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{1,2}:\d{2}(?::\d{2})?/g;

/** Whole digit runs of a visitor message that could be a phone number (separators allowed inside a run). */
function phoneRuns(text: string): string[] {
  const t = toLatinDigits(text).replace(DATE_OR_TIME, " , ");
  return [...t.matchAll(/\+?\d[\d \-().]{5,}\d|\d{7,}/g)].map((m) => m[0]);
}

/**
 * The number must equal a WHOLE digit run of a visitor message after normalisation: no substring of a longer
 * number ("0044 500000000" does not ground 0500000000) and no digits borrowed from a date.
 */
export function phoneGrounded(phone: string, userTexts: string[]): boolean {
  const key = phoneKey(phone);
  if (key.length < 7) return false;
  return userTexts.some((t) => phoneRuns(t).some((r) => phoneKey(r) === key));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The address must appear as its own token: "xsara@gmail.com" does not ground "sara@gmail.com". */
export function emailGrounded(email: string, userTexts: string[]): boolean {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  const re = new RegExp(`(?<![\\w.%+-])${escapeRe(e)}(?![\\w-]|\\.\\w)`, "u");
  return userTexts.some((t) => re.test(t.normalize("NFKC").toLowerCase()));
}

/** Words that are commands or filler, never a person's name on their own. */
const NOT_A_NAME = new Set(["book", "now", "yes", "no", "ok", "okay", "confirm", "please", "thanks", "hello", "hi", "حجز", "تاكيد", "نعم", "لا", "تمام", "شكرا", "مرحبا"]);

/**
 * Every word of the full name must appear as a WHOLE word (Arabic-normalised, case-insensitive) in ONE visitor
 * message: not a prefix ("Moh" is not grounded by "Mohammed"), not words scattered across the chat, and a name
 * made only of command words ("Book Now") is never grounded.
 */
export function nameGrounded(name: string, userTexts: string[]): boolean {
  const words = normalizeText(name).split(" ").filter(Boolean);
  if (words.length === 0) return false;
  if (words.every((w) => NOT_A_NAME.has(w))) return false;
  return userTexts.some((t) => {
    const hay = ` ${normalizeText(t)} `;
    return words.every((w) => hay.includes(` ${w} `));
  });
}

/** Placeholder local parts, compared exactly (after lower-casing), so test+1@gmail.com or info@x.sa stay real. */
const PLACEHOLDER_LOCAL = new Set([
  "test", "tester", "testing", "noemail", "no-email", "none", "null", "nobody", "noreply", "no-reply", "donotreply", "do-not-reply",
  "abc", "asdf", "xyz", "sample", "example", "yourname", "youremail",
]);
const PLACEHOLDER_DOMAIN_RAW = ["example.com", "example.net", "example.org", "test.com", "domain.com", "yourdomain.com", "mydomain.com", "email.com"];
const PLACEHOLDER_TLD_RAW = ["invalid", "test", "example", "localhost", "local"];

/** Fold look-alikes (capital I, digit 1, Cyrillic letters, fullwidth, ideographic dot) so "exampIe.com" / "examp1e.com" are caught. */
function foldHomoglyphs(s: string): string {
  const cyr: Record<string, string> = { а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", і: "i", ј: "j", ѕ: "s" };
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[。．｡]/g, ".")
    .replace(/[а-яіјѕ]/g, (c) => cyr[c] ?? c)
    .replace(/[il1|!]/g, "l")
    .replace(/0/g, "o")
    .replace(/3/g, "e")
    .replace(/4/g, "a");
}

const PLACEHOLDER_DOMAIN = new Set(PLACEHOLDER_DOMAIN_RAW.map((d) => foldHomoglyphs(d)));
const PLACEHOLDER_TLD = new Set(PLACEHOLDER_TLD_RAW.map((d) => foldHomoglyphs(d)));

/** Placeholder or role-like email: treated as "no email provided". Malformed text is NOT a placeholder (the format check rejects it). */
export function isPlaceholderEmail(email: string): boolean {
  const raw = email.trim();
  const at = raw.lastIndexOf("@");
  if (at < 1) return false;
  const local = raw.slice(0, at).toLowerCase();
  const domain = foldHomoglyphs(raw.slice(at + 1));
  const tld = domain.split(".").pop() ?? "";
  return PLACEHOLDER_LOCAL.has(local) || PLACEHOLDER_DOMAIN.has(domain) || PLACEHOLDER_TLD.has(tld) || domain === foldHomoglyphs("localhost");
}

export type Grounding =
  | { ok: true }
  | { ok: false; field: "name" | "phone" | "email"; voiceOnly: boolean };

export function groundingMessage(field: "name" | "phone" | "email", voiceOnly: boolean): string {
  const base = `The ${field} you sent is not something the visitor wrote in this conversation. Ask the visitor for their ${field} and wait for their answer; never invent, guess or reuse a placeholder.`;
  return voiceOnly
    ? `${base} Voice notes cannot be used for this: ask the visitor to TYPE the ${field} in the chat.`
    : base;
}

/** The name as it will be stored and shown: odd punctuation runs ("SARA...ALI") become single spaces. */
export function cleanName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\s'’-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The phone as it will be stored and shown: Saudi mobiles in +9665XXXXXXXX form, other numbers as typed (digits, + kept). */
export function cleanPhone(phone: string): string {
  const key = phoneKey(phone);
  if (key.length === 9 && key.startsWith("5")) return `+966${key}`;
  const digits = toLatinDigits(phone).replace(/\D+/g, "");
  return /^\s*(\+|00)/.test(phone) ? `+${digits.replace(/^00/, "")}` : digits;
}
