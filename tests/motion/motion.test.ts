import { describe, expect, it } from "vitest";
import { countText, easeOutCubic, hasNumber, toLatinDigits } from "@/lib/motion/count";
import { MAX_STAGGER, shouldArm, staggerDelay, STAGGER_MS } from "@/lib/motion/reveal";

describe("countText", () => {
  const finals = ["24", "٢٤", "1,250", "1,250.50 SAR", "١٢٬٣٤٥٫٥٠ ر.س", "12%", "٦٪", "-", "0"];
  it("returns the original text exactly at progress 1 and above", () => {
    for (const f of finals) {
      expect(countText(f, 1)).toBe(f);
      expect(countText(f, 1.5)).toBe(f);
    }
  });
  it("starts at zero in the same digit script", () => {
    expect(countText("24", 0)).toBe("0");
    expect(countText("٢٤", 0)).toBe("٠");
    expect(countText("1,250.50 SAR", 0)).toBe("0.00 SAR");
    expect(countText("12%", 0)).toBe("0%");
  });
  it("keeps grouping and decimals mid-flight", () => {
    expect(countText("1,250", 0.5)).toBe("625");
    expect(countText("2,000", 0.5)).toBe("1,000");
    expect(countText("10.00", 0.5)).toBe("5.00");
    expect(countText("٢٠٠٠", 0.5)).toBe("١٠٠٠");
  });
  it("leaves text without digits alone", () => {
    expect(countText("-", 0.3)).toBe("-");
    expect(hasNumber("-")).toBe(false);
    expect(hasNumber("٦")).toBe(true);
  });
  it("converts digit scripts", () => {
    expect(toLatinDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });
  it("eases from 0 to 1 monotonically", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.3)).toBeLessThan(easeOutCubic(0.6));
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe("reveal rules", () => {
  it("never arms anything touching the first viewport", () => {
    expect(shouldArm({ top: 0, bottom: 300 }, 800)).toBe(false);
    expect(shouldArm({ top: 799, bottom: 900 }, 800)).toBe(false);
    expect(shouldArm({ top: -200, bottom: 100 }, 800)).toBe(false);
    expect(shouldArm({ top: 800, bottom: 900 }, 800)).toBe(true);
    expect(shouldArm({ top: 1500, bottom: 1700 }, 800)).toBe(true);
  });
  it("caps the stagger", () => {
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(2)).toBe(2 * STAGGER_MS);
    expect(staggerDelay(50)).toBe(MAX_STAGGER * STAGGER_MS);
    expect(staggerDelay(-3)).toBe(0);
  });
});
