import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRAND,
  INK,
  brandStyleVars,
  contrastRatio,
  parseBrandColor,
  readablePair,
  readableTextOn,
} from "./brand";

describe("parseBrandColor", () => {
  it("accepts strict #rrggbb and lowercases", () => {
    expect(parseBrandColor("#2549D1")).toBe("#2549d1");
    expect(parseBrandColor("#000000")).toBe("#000000");
  });
  it.each([null, undefined, 5, "", "2549d1", "#fff", "#12345", "#1234567", "#gggggg",
    "red", "#2549d1;} body{display:none", "url(x)", " #2549d1", "#2549d1\n", "#2549d1ff"])(
    "rejects %j",
    (v) => expect(parseBrandColor(v)).toBeNull(),
  );
});

describe("contrast", () => {
  it("matches known WCAG ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
  it("uses white on dark and ink on light brand colours", () => {
    expect(readableTextOn(DEFAULT_BRAND)).toBe("#ffffff");
    expect(readableTextOn("#000000")).toBe("#ffffff");
    expect(readableTextOn("#ffff00")).toBe(INK);
    expect(readableTextOn("#f2a93b")).toBe(INK);
  });
  it("reaches 4.5:1 on typical colours and never picks the worse option", () => {
    for (const c of ["#2549d1", "#ffffff", "#767676", "#00a86b", "#f2a93b", "#000000"]) {
      expect(contrastRatio(readableTextOn(c), c)).toBeGreaterThanOrEqual(4.5);
    }
    for (const c of ["#808080", "#ff69b4"]) {
      const other = readableTextOn(c) === INK ? "#ffffff" : INK;
      expect(contrastRatio(readableTextOn(c), c)).toBeGreaterThanOrEqual(contrastRatio(other, c));
    }
  });
});

describe("brandStyleVars", () => {
  it("falls back to default cobalt for null or invalid", () => {
    for (const v of [null, "javascript:1", "#12"]) {
      expect(brandStyleVars(v)["--cobalt"]).toBe(DEFAULT_BRAND);
    }
  });
  it("applies a valid colour and only emits hex values", () => {
    const vars = brandStyleVars("#FFEE00");
    expect(vars["--cobalt"]).toBe("#ffee00");
    expect(vars["--brand-fg"]).toBe(INK);
    for (const val of Object.values(vars)) expect(val).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("readablePair (AA for any brand colour)", () => {
  it("leaves already readable colours unchanged", () => {
    expect(readablePair(DEFAULT_BRAND)).toEqual({ bg: DEFAULT_BRAND, fg: "#ffffff" });
    expect(readablePair("#ffee00")).toEqual({ bg: "#ffee00", fg: INK });
  });
  it("darkens mid-tones where neither white nor ink reaches 4.5:1", () => {
    for (const c of ["#808080", "#2e8b57", "#777777", "#e91e63", "#00897b"]) {
      expect(contrastRatio(WHITE_OR_INK(c), c)).toBeLessThan(4.5);
      const p = readablePair(c);
      expect(contrastRatio(p.fg, p.bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("reaches 4.5:1 over a dense RGB grid and a pseudo-random sample, and brandStyleVars agrees", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const hexes: string[] = [];
    for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17)
      hexes.push("#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join(""));
    for (let i = 0; i < 3000; i++)
      hexes.push("#" + [0, 0, 0].map(() => Math.floor(rnd() * 256).toString(16).padStart(2, "0")).join(""));
    for (const hex of hexes) {
      const p = readablePair(hex);
      expect(contrastRatio(p.fg, p.bg), hex).toBeGreaterThanOrEqual(4.5);
      const vars = brandStyleVars(hex);
      expect(contrastRatio(vars["--brand-fg"], vars["--cobalt"]), hex).toBeGreaterThanOrEqual(4.5);
    }
  });
});

function WHITE_OR_INK(c: string): string {
  return readableTextOn(c);
}
