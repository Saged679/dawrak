/**
 * Count-up helpers (pure, no DOM). A displayed value like "٢٤", "1,250.50 SAR" or "12%" is split into
 * numeric runs; each run is rendered at a fraction of its final value in the same digit script,
 * with the same decimals and grouping. At progress >= 1 the ORIGINAL text is returned untouched, so
 * the animation can never end on a wrong number.
 */
const DIGITS = "0-9٠-٩";
const RUN = new RegExp(
  `[${DIGITS}]+(?:[,٬][${DIGITS}]{3})*(?:[.٫][${DIGITS}]+)?`,
  "g",
);

const ARABIC_ZERO = 0x0660;

export function toLatinDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - ARABIC_ZERO));
}
function toArabicDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => String.fromCharCode(ARABIC_ZERO + Number(d)));
}

export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

function renderRun(run: string, progress: number): string {
  const arabic = /[٠-٩]/.test(run);
  const latin = toLatinDigits(run);
  const decSep = /[٫]/.test(run) ? "٫" : ".";
  const grpSep = /[٬]/.test(run) ? "٬" : ",";
  const grouped = /[,٬]/.test(run);
  const [intPart, frac = ""] = latin.replace(/[,٬]/g, "").replace("٫", ".").split(".");
  const final = Number(`${intPart}.${frac || "0"}`);
  const decimals = frac.length;
  const now = final * progress;
  let out = decimals ? now.toFixed(decimals) : String(Math.round(now));
  const [i0, f] = out.split(".");
  let i = i0;
  if (grouped) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, grpSep);
  out = f !== undefined ? `${i}${decSep}${f}` : i;
  return arabic ? toArabicDigits(out) : out;
}

/** The text to show at `progress` (0..1, already eased). */
export function countText(finalText: string, progress: number): string {
  if (progress >= 1) return finalText;
  const p = Math.max(0, progress);
  return finalText.replace(RUN, (run) => renderRun(run, p));
}

export function hasNumber(text: string): boolean {
  return new RegExp(RUN.source).test(text);
}
