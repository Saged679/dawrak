import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useLocale: () => "ar" }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: Record<string, unknown>) =>
    createElement("a", { "data-i18n-link": "1", href, ...rest }, children as never),
}));

import { Logo, LogoMark } from "@/components/brand/logo";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("LogoMark", () => {
  it("is aria-hidden and has no text glyphs", () => {
    const out = html(createElement(LogoMark, { size: 40 }));
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain("<text");
    expect(out.replace(/<[^>]*>/g, "")).toBe("");
  });
  it.each([
    ["color", "#2549D1"],
    ["mono-light", "#FFFFFF"],
    ["mono-dark", "#101C3A"],
  ] as const)("renders tone %s", (tone, fill) => {
    const out = html(createElement(LogoMark, { tone }));
    expect(out).toContain(`data-tone="${tone}"`);
    expect(out).toContain(`fill="${fill}"`);
    if (tone !== "color") expect(out).not.toContain("#2549D1");
  });
});

describe("Logo", () => {
  it("uses the i18n Link and defaults to home", () => {
    const out = html(createElement(Logo));
    expect(out).toContain('data-i18n-link="1"');
    expect(out).toContain('href="/"');
  });
  it("honours href override", () => {
    expect(html(createElement(Logo, { href: "/dashboard" }))).toContain('href="/dashboard"');
  });
  it("name is the wordmark text (no aria-label that could break WCAG 2.5.3)", () => {
    const out = html(createElement(Logo));
    expect(out).toContain("دورك");
    expect(out).not.toContain("aria-label=\"دورك");
    expect(html(createElement(Logo, { locale: "en" }))).toContain("Dawrak");
  });
  it("mark-only gets an aria-label starting with the wordmark", () => {
    const out = html(createElement(Logo, { showWordmark: false }));
    expect(out).toContain('aria-label="دورك — الصفحة الرئيسية"');
  });
});
