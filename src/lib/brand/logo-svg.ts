import {
  LOGO_BUBBLE_LTR,
  LOGO_BUBBLE_RTL,
  LOGO_COLORS,
  LOGO_DOT_GAP,
  LOGO_DOT_LTR,
  LOGO_DOT_RTL,
  LOGO_TICK_PATH,
  LOGO_TICK_WIDTH,
  LOGO_VIEWBOX,
} from "./logo-geometry";

export type LogoSvgOptions = {
  size?: number;
  dir?: "ltr" | "rtl";
  /** "color": cobalt bubble, white tick. "on-cobalt": white bubble, cobalt tick (for a cobalt tile). */
  tone?: "color" | "on-cobalt";
  /**
   * Solid tile behind the mark. With a tile the dot gap and the tick are painted in tile colours (no SVG mask,
   * which Satori/resvg-in-Satori may not support). Without a tile the mark is transparent and a mask punches the gap.
   */
  tile?: { bg?: string; /** mark size as a fraction of the tile, 0-1 */ scale?: number };
};

const TONES = {
  color: { bubble: LOGO_COLORS.cobalt, dot: LOGO_COLORS.saffron, tick: LOGO_COLORS.white, tileBg: LOGO_COLORS.mist },
  "on-cobalt": { bubble: LOGO_COLORS.white, dot: LOGO_COLORS.saffron, tick: LOGO_COLORS.cobalt, tileBg: LOGO_COLORS.cobalt },
} as const;

/** Standalone SVG markup of the logo mark. Only constants are interpolated: safe to inline in HTML. */
export function logoSvg({ size = 64, dir = "ltr", tone = "color", tile }: LogoSvgOptions = {}): string {
  const t = TONES[tone];
  const dot = dir === "ltr" ? LOGO_DOT_LTR : LOGO_DOT_RTL;
  const bubble = dir === "ltr" ? LOGO_BUBBLE_LTR : LOGO_BUBBLE_RTL;
  const tickEl = (stroke: string) =>
    `<path d="${LOGO_TICK_PATH}" fill="none" stroke="${stroke}" stroke-width="${LOGO_TICK_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const gapR = dot.r + LOGO_DOT_GAP;
  const v = LOGO_VIEWBOX;

  if (!tile) {
    // Transparent: bubble masked so the dot gap is see-through; tick drawn on top (white) or knocked out.
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${v} ${v}" width="${size}" height="${size}">` +
      `<defs><mask id="g" maskUnits="userSpaceOnUse" x="0" y="0" width="${v}" height="${v}"><rect width="${v}" height="${v}" fill="#fff"/>` +
      `<circle cx="${dot.cx}" cy="${dot.cy}" r="${gapR}" fill="#000"/></mask></defs>` +
      `<path d="${bubble}" fill="${t.bubble}" mask="url(#g)"/>` +
      `<circle cx="${dot.cx}" cy="${dot.cy}" r="${dot.r}" fill="${t.dot}"/>` +
      tickEl(t.tick) +
      `</svg>`
    );
  }
  const bg = tile.bg ?? t.tileBg;
  const scale = tile.scale ?? 0.6;
  const k = scale; // mark scale inside the tile viewBox (tile viewBox is also 64 wide)
  const off = (v - v * k) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${v} ${v}" width="${size}" height="${size}">` +
    `<rect width="${v}" height="${v}" fill="${bg}"/>` +
    `<g transform="translate(${off} ${off}) scale(${k})">` +
    `<path d="${bubble}" fill="${t.bubble}"/>` +
    `<circle cx="${dot.cx}" cy="${dot.cy}" r="${gapR}" fill="${bg}"/>` +
    `<circle cx="${dot.cx}" cy="${dot.cy}" r="${dot.r}" fill="${t.dot}"/>` +
    tickEl(t.tick) +
    `</g></svg>`
  );
}

/** `data:` URI for use as <img src> in Satori/ImageResponse (base64 so no escaping issues). */
export function logoDataUri(opts?: LogoSvgOptions): string {
  return `data:image/svg+xml;base64,${Buffer.from(logoSvg(opts)).toString("base64")}`;
}
