/**
 * Lexical (keyword) search over a tenant's knowledge chunks: the fallback when the semantic search has
 * nothing usable (chunks without embeddings, e.g. the ones reset_demo() seeds; embedding quota; empty result).
 * Pure functions, Arabic and Latin text, BM25-like scoring.
 */

const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Lowercase, strip diacritics/tatweel, unify alef/ya/ta-marbuta/hamza variants and digits, drop punctuation. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(DIACRITICS, "")
    .replace(TATWEEL, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const STOPWORDS_RAW = [
  // Arabic
  "ما", "ماذا", "ماهي", "ماهو", "هي", "هو", "عندنا", "عندي", "هل", "في", "من", "على", "الى", "إلى", "عن", "مع", "هذا", "هذه", "ذلك", "تلك", "كم",
  "كيف", "متى", "اين", "أين", "لو", "او", "أو", "ان", "أن", "إن", "كان", "يكون", "عندكم", "عندك", "لديكم", "لكم",
  "لي", "انا", "أنا", "نحن", "انت", "أنت", "ممكن", "لو", "سمحت", "فضلك", "بس", "ايش", "وش", "شو", "ايه", "إيه",
  "هذي", "هاذي", "هاد", "الي", "اللي", "الذي", "التي", "ولا", "لا", "نعم", "يا", "قد", "كل", "بعد", "قبل", "حتى",
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "do", "does", "did", "you", "your", "yours", "what", "when",
  "how", "where", "which", "who", "whom", "why", "i", "we", "our", "us", "me", "my", "of", "to", "in", "on", "for",
  "and", "or", "can", "could", "would", "will", "have", "has", "it", "its", "this", "that", "these", "those", "with",
  "at", "by", "from", "about", "there", "any", "please", "tell", "know", "want", "need", "if", "as", "so",
];
const STOPWORDS = new Set(STOPWORDS_RAW.map(normalizeText));

/** Arabic proclitics: ال, وال, بال, كال, فال, لل, and a single leading و/ب/ل/ف/ك before a long word. */
function stem(token: string): string {
  let t = token;
  if (/^[a-z]+$/.test(t)) {
    if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
    if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
    return t;
  }
  t = t.replace(/^(وال|بال|كال|فال|ولل|لل|ال)(?=.{2,})/, "");
  if (t.length >= 5) t = t.replace(/^[وبلفك](?=.{4,})/, "");
  return t;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeText(text).split(" ")) {
    if (!raw || STOPWORDS.has(raw)) continue;
    if (raw.length < 2 && !/\d/.test(raw)) continue;
    const s = stem(raw);
    if (s && !STOPWORDS.has(s)) out.push(s);
  }
  return out;
}

/**
 * Small bilingual concept table: a question in one language can find content written in the other
 * (the demo knowledge base is Arabic, visitors also ask in English). Any word of a concept expands to all of them.
 */
const CONCEPTS: string[][] = [
  ["hour", "hours", "open", "opening", "closing", "close", "schedule", "timing", "working", "ساعات", "دوام", "مواعيد", "أوقات", "فتح", "إغلاق", "عمل"],
  ["location", "address", "directions", "map", "موقع", "عنوان", "مكان", "خريطة"],
  ["deposit", "advance", "عربون", "مقدم", "دفعة"],
  ["insurance", "insured", "تأمين", "التأمين"],
  ["price", "prices", "cost", "fee", "fees", "سعر", "أسعار", "تكلفة", "رسوم"],
  ["cancel", "cancellation", "refund", "إلغاء", "استرداد", "استرجاع"],
  ["pay", "payment", "paid", "دفع", "سداد"],
  ["parking", "موقف", "مواقف"],
  ["phone", "call", "contact", "هاتف", "جوال", "اتصال", "تواصل"],
];
const CONCEPT_OF = new Map<string, string[]>();
for (const group of CONCEPTS) {
  const stems = [...new Set(group.flatMap((w) => tokenize(w)))];
  for (const st of stems) CONCEPT_OF.set(st, stems);
}

export type LexicalHit = { id: string; content: string; score: number };

const K1 = 1.2;
const B = 0.75;
/** Weight of a prefix match ("open" ~ "opening", "ساعات" ~ "ساعه") against an exact token match. */
const PARTIAL = 0.6;

function matchWeight(q: string[], d: string): number {
  return Math.max(...q.map((x) => matchOne(x, d)));
}
function matchOne(q: string, d: string): number {
  if (q === d) return 1;
  if (q.length >= 4 && d.length >= 4 && (d.startsWith(q) || q.startsWith(d))) return PARTIAL;
  return 0;
}

/**
 * BM25-like ranking. A chunk qualifies when it matches at least `minCoverage` of the query terms (weighted by
 * idf) and scores above `threshold`; the top `k` are returned, best first (ties keep the original order).
 */
export function lexicalSearch(
  chunks: { id: string; content: string }[],
  query: string,
  { k = 4, threshold = 0.1, minCoverage = 0.34 }: { k?: number; threshold?: number; minCoverage?: number } = {},
): LexicalHit[] {
  const base = [...new Set(tokenize(query))];
  if (base.length === 0 || chunks.length === 0) return [];
  // each query term becomes a group of alternatives (itself + its translations/synonyms); duplicates of one concept collapse
  const seen = new Set<string>();
  const qTerms: string[][] = [];
  for (const q of base) {
    const alts = CONCEPT_OF.get(q) ?? [q];
    const key = [...alts].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    qTerms.push(alts);
  }

  const docs = chunks.map((c) => ({ c, tokens: tokenize(c.content) }));
  const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / docs.length || 1;
  const N = docs.length;

  const idf = new Map<string[], number>();
  for (const q of qTerms) {
    const df = docs.filter((d) => d.tokens.some((t) => matchWeight(q, t) > 0)).length;
    idf.set(q, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  }
  const totalIdf = qTerms.reduce((s, q) => s + (idf.get(q) ?? 0), 0) || 1;

  const hits: (LexicalHit & { order: number })[] = [];
  docs.forEach((d, order) => {
    let score = 0;
    let covered = 0;
    for (const q of qTerms) {
      let tf = 0;
      for (const t of d.tokens) tf += matchWeight(q, t);
      if (tf === 0) continue;
      const w = idf.get(q) ?? 0;
      score += w * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (d.tokens.length / avgLen))));
      covered += w;
    }
    if (score >= threshold && covered / totalIdf >= minCoverage) {
      hits.push({ id: d.c.id, content: d.c.content, score, order });
    }
  });
  return hits
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, k)
    .map(({ id, content, score }) => ({ id, content, score }));
}
