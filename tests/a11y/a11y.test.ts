import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { buildClinicBreadcrumbJsonLd } from "@/components/booking/breadcrumb-jsonld";
import { brandStyleVars, contrastRatio } from "@/lib/db/brand";
import { serializeJsonLd } from "@/lib/seo/jsonld";

describe("clinic header contrast (solid colours, no opacity)", () => {
  // The header pill is brand-fg background with brand-coloured text; the rest is brand-fg on brand.
  for (const brand of ["#0f766e", "#be185d", "#2549d1"]) {
    it(`${brand}: foreground on brand and brand on foreground reach 4.5:1`, () => {
      const fg = brandStyleVars(brand)["--brand-fg"];
      expect(contrastRatio(fg, brand)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("accessible names start with the visible text (WCAG 2.5.3)", () => {
  it("block label templates start with {customer}", () => {
    const find = (o: unknown): string[] =>
      typeof o === "object" && o
        ? Object.entries(o).flatMap(([k, v]) => (k === "block" && typeof v === "string" ? [v] : find(v)))
        : [];
    for (const m of [...find(en), ...find(ar)]) expect(m.startsWith("{customer}")).toBe(true);
  });
  it("Arabic demo visitor is translated", () => {
    expect(ar.Dash.menu.demoVisitor).not.toBe("Demo visitor");
    expect(en.Dash.menu.demoVisitor).toBe("Demo visitor");
  });
});

describe("clinic breadcrumb JSON-LD", () => {
  it("has home then business, and survives hostile names", () => {
    const ld = buildClinicBreadcrumbJsonLd({
      base: "https://dawrak.example",
      locale: "en",
      slug: "nabd",
      siteName: "Dawrak",
      businessName: "</script>Nabd",
    });
    expect(ld["@type"]).toBe("BreadcrumbList");
    expect(ld.itemListElement.map((i) => i.position)).toEqual([1, 2]);
    expect(ld.itemListElement[1].item).toBe("https://dawrak.example/en/c/nabd");
    expect(serializeJsonLd(ld)).not.toContain("<");
  });
});
