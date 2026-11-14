import { describe, expect, it } from "vitest";
import { cleanAssistantText as c } from "@/components/chat/sanitize";

describe("cleanAssistantText", () => {
  it("turns * and - bullets into a bullet character", () => {
    expect(c("*   Dr Sara\n- Dr Omar\n+ Dr Lina\n• Dr Ali")).toBe("• Dr Sara\n• Dr Omar\n• Dr Lina\n• Dr Ali");
  });
  it("strips ** and __ markers but keeps the text", () => {
    expect(c("This is **very** important and __this__ too")).toBe("This is very important and this too");
  });
  it("handles nested symbols: bullet + bold + italics", () => {
    expect(c("*   **الوقت:** *الأحد* الساعة 9")).toBe("• الوقت: الأحد الساعة 9");
    expect(c("* **bold *and italic* inside**")).toBe("• bold and italic inside");
  });
  it("strips heading markers", () => {
    expect(c("# Title\n### Sub title\nbody")).toBe("Title\nSub title\nbody");
  });
  it("Arabic text with Markdown", () => {
    expect(c("**مرحباً!** هذه الأوقات المتاحة:\n*   الأحد ٩:٠٠\n*   الاثنين ١٠:٣٠")).toBe(
      "مرحباً! هذه الأوقات المتاحة:\n• الأحد ٩:٠٠\n• الاثنين ١٠:٣٠",
    );
  });
  it("leaves ordinary text alone: math, negative numbers, snake_case, hashtags mid-text, plain Arabic", () => {
    for (const t of ["2 * 3 = 6", "-5 degrees", "use snake_case_name here", "room #5 is free", "أهلاً بك، كيف أساعدك؟", "Hello! 1) 10:00 2) 11:00"]) {
      expect(c(t)).toBe(t);
    }
  });
  it("removes an unfinished marker while streaming", () => {
    expect(c("The price is **50")).toBe("The price is 50");
    expect(c("*")).toBe("*"); // a lone asterisk is not a bullet until it has text
  });
  it("strips inline code ticks and blockquote markers", () => {
    expect(c("call `list_services` now\n> quoted")).toBe("call list_services now\nquoted");
  });
  it("collapses blank-line runs and trailing spaces", () => {
    expect(c("a  \n\n\n\nb")).toBe("a\n\nb");
  });
  it("never produces markup: HTML stays literal text for React to escape", () => {
    expect(c("<b>hi</b> <script>alert(1)</script>")).toBe("<b>hi</b> <script>alert(1)</script>");
  });
  it("empty input", () => {
    expect(c("")).toBe("");
  });
});
