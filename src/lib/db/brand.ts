/** Tenant brand colour helpers. Pure functions, no I/O. */

export const DEFAULT_BRAND = "#2549d1";
export const INK = "#101c3a";
const WHITE = "#ffffff";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Returns the lowercase `#rrggbb` string, or null for anything else (never trust stored values). */
export function parseBrandColor(value: unknown): string | null {
  if (typeof value !== "string" || !HEX_RE.test(value)) return null;
  return value.toLowerCase();
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 2.x relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#rrggbb` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** White text when it reaches 4.5:1 on the colour, otherwise whichever of ink/white contrasts more. */
export function readableTextOn(bg: string): string {
  const white = contrastRatio(WHITE, bg);
  if (white >= 4.5) return WHITE;
  return contrastRatio(INK, bg) >= white ? INK : WHITE;
}

function darken(hex: string, factor: number): string {
  return `#${channels(hex)
    .map((c) => Math.round(c * factor).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** CSS variables for the public page. Only validated hex values ever reach the style attribute. */
export function brandStyleVars(raw: unknown): Record<string, string> {
  const brand = parseBrandColor(raw) ?? DEFAULT_BRAND;
  const fg = readableTextOn(brand);
  const deep = darken(brand, 0.72);
  return {
    "--cobalt": brand,
    "--cobalt-deep": deep,
    "--primary": brand,
    "--primary-foreground": fg,
    "--ring": brand,
    "--brand-fg": fg,
  };
}
