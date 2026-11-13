import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRAND,
  INK,
  brandStyleVars,
  contrastRatio,
  parseBrandColor,
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
