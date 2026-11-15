// i18n completeness: key parity ar<->en, empty strings, untranslated copies, placeholder parity.
import { readFileSync } from "node:fs";
const load = (l) => JSON.parse(readFileSync(new URL(`../messages/${l}.json`, import.meta.url), "utf8"));
const flat = (o, p = "", out = {}) => { for (const [k, v] of Object.entries(o)) { const key = p ? `${p}.${k}` : k; if (v && typeof v === "object") flat(v, key, out); else out[key] = v; } return out; };
const ar = flat(load("ar")), en = flat(load("en"));
const miss = (a, b) => Object.keys(a).filter((k) => !(k in b));
const ALLOW_IDENTICAL = new Set(["Landing.hero.transcriptOriginal"]); // intentionally English in both locales
const out = {
  keysTotal: { ar: Object.keys(ar).length, en: Object.keys(en).length },
  missingInEn: miss(ar, en), missingInAr: miss(en, ar),
  emptyAr: Object.keys(ar).filter((k) => !ALLOW_IDENTICAL.has(k) && typeof ar[k] === "string" && !ar[k].trim()),
  emptyEn: Object.keys(en).filter((k) => typeof en[k] === "string" && !en[k].trim()),
  nonStringAr: Object.keys(ar).filter((k) => typeof ar[k] !== "string"),
  arHasNoArabicLetters: Object.keys(ar).filter((k) => k in en && !ALLOW_IDENTICAL.has(k) && typeof ar[k] === "string" && !/[\u0600-\u06FF]/.test(ar[k])),
  identicalAndHasLatin: Object.keys(ar).filter((k) => k in en && !ALLOW_IDENTICAL.has(k) && ar[k] === en[k] && /[A-Za-z]{3,}/.test(ar[k])),
  placeholderMismatch: Object.keys(ar).filter((k) => k in en && typeof ar[k] === "string" && typeof en[k] === "string" &&
    JSON.stringify([...ar[k].matchAll(/\{(\w+)/g)].map((m) => m[1]).sort()) !== JSON.stringify([...en[k].matchAll(/\{(\w+)/g)].map((m) => m[1]).sort())),
};
console.log(JSON.stringify(out, null, 1));
const failed = ["missingInEn", "missingInAr", "emptyAr", "emptyEn", "nonStringAr", "placeholderMismatch"].filter((k) => out[k].length);
if (failed.length) { console.error("i18n check failed:", failed.join(", ")); process.exit(1); }
