import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import manifest from "@/app/manifest";
import proxy from "@/proxy";
import { NextRequest } from "next/server";
import { LOGO_COLORS, LOGO_BUBBLE_LTR, LOGO_BUBBLE_RTL, LOGO_TICK_PATH } from "@/lib/brand/logo-geometry";
import { logoDataUri, logoSvg } from "@/lib/brand/logo-svg";
import { pngToIco } from "@/lib/brand/icon-image";
import { buildLandingJsonLd } from "@/lib/seo/jsonld";
import { renderOgImage } from "@/lib/seo/og";
import { config } from "@/proxy";

describe("logo svg builder", () => {
  it("uses only the shared geometry and has no text", () => {
    const s = logoSvg();
    expect(s).toContain(LOGO_BUBBLE_LTR);
    expect(s).toContain(LOGO_TICK_PATH);
    expect(s).toContain(LOGO_COLORS.cobalt);
    expect(s).not.toContain("<text");
    expect(logoSvg({ dir: "rtl" })).toContain(LOGO_BUBBLE_RTL);
  });
  it("the tile variant avoids SVG masks (Satori safe) and paints the gap in the tile colour", () => {
    const s = logoSvg({ tone: "on-cobalt", tile: {} });
    expect(s).not.toContain("<mask");
    expect(s).toContain(`fill="${LOGO_COLORS.cobalt}"`);
  });
  it("data URI decodes to the same svg", () => {
    const uri = logoDataUri({ size: 32 });
    expect(Buffer.from(uri.split(",")[1], "base64").toString()).toBe(logoSvg({ size: 32 }));
  });
  it("src/app/icon.svg is generated from the same geometry", () => {
    expect(readFileSync("src/app/icon.svg", "utf8").trim()).toBe(logoSvg({ size: 64 }));
  });
});

describe("manifest", () => {
  const m = manifest();
  it("names, colours, display", () => {
    expect(m.name).toContain("Dawrak");
    expect(m.name).toContain("دورك");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toBe(LOGO_COLORS.cobalt);
    expect(m.background_color).toBe(LOGO_COLORS.mist);
  });
  it("has 192 and 512 PNG icons plus a maskable one", () => {
    const icons = m.icons ?? [];
    expect(icons.some((i) => i.sizes === "192x192" && i.type === "image/png")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
  });
});

describe("ico container", () => {
  it("wraps a PNG with a valid header", () => {
    const png = new Uint8Array([1, 2, 3, 4]);
    const ico = pngToIco(png, 48);
    expect([...ico.subarray(0, 6)]).toEqual([0, 0, 1, 0, 1, 0]);
    expect(ico[6]).toBe(48);
    expect(new DataView(ico.buffer).getUint32(14, true)).toBe(4);
    expect(new DataView(ico.buffer).getUint32(18, true)).toBe(22);
    expect([...ico.subarray(22)]).toEqual([1, 2, 3, 4]);
  });
});

describe("proxy matcher", () => {
  it("skips the icon assets but not pages", () => {
    const re = new RegExp(`^${config.matcher[0]}$`);
    for (const p of ["/apple-icon", "/icon.svg", "/favicon.ico", "/manifest.webmanifest", "/icon-512.png", "/icon-192.png"]) {
      expect(re.test(p), p).toBe(false);
    }
    for (const p of ["/", "/ar", "/en/login", "/ar/c/x"]) expect(re.test(p), p).toBe(true);
  });
});

describe("inline 404 html", () => {
  for (const [locale, dir] of [["ar", "rtl"], ["en", "ltr"]] as const) {
    it(`${locale}: logo plus lang, dir, h1, noindex, home link`, async () => {
      const res = await proxy(new NextRequest(`http://localhost:3100/${locale}/nope`));
      const html = await res.text();
      expect(res.status).toBe(404);
      expect(html).toContain("<svg");
      expect(html).toContain(dir === "rtl" ? LOGO_BUBBLE_RTL : LOGO_BUBBLE_LTR);
      expect(html).toContain(`<html lang="${locale}" dir="${dir}"`);
      expect(html).toMatch(/<h1>[^<]+<\/h1>/);
      expect(html).toContain('name="robots" content="noindex"');
      expect(html).toContain(`href="/${locale}"`);
      expect(html).not.toContain("<script");
    });
  }
});

describe("JSON-LD", () => {
  it("Organization has an absolute PNG logo", () => {
    const ld = buildLandingJsonLd({ base: "https://x.test", locale: "en", name: "Dawrak", description: "d", faq: [] });
    const org = ld["@graph"].find((g) => g["@type"] === "Organization") as { logo: string };
    expect(org.logo).toBe("https://x.test/icon-512.png");
  });
});

describe("OG image", () => {
  for (const locale of ["ar", "en"] as const) {
    it(`${locale}: renders a 1200x630 PNG`, async () => {
      const res = await renderOgImage({ locale, brand: "Dawrak", title: "Title", subtitle: "Sub", badge: "Demo" });
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.subarray(1, 4).toString()).toBe("PNG");
      expect(buf.readUInt32BE(16)).toBe(1200);
      expect(buf.readUInt32BE(20)).toBe(630);
    }, 30_000);
  }
});

describe("copy", () => {
  it("login and navigation keys exist in both languages", () => {
    for (const m of [ar, en]) {
      for (const k of ["backHome", "noSignup", "demoPrompt", "tryDemo"] as const) expect(m.Auth[k].length).toBeGreaterThan(3);
      expect(m.Dash.mainSite.length).toBeGreaterThan(3);
      expect(m.Brand.poweredBy).toContain(m === ar ? "دورك" : "Dawrak");
      expect(m.Demo.backHome.length).toBeGreaterThan(3);
      expect(m.Mailbox.backHome.length).toBeGreaterThan(3);
      expect("home" in m.Landing.nav).toBe(false);
    }
  });
  it("demo accounts live 6 hours, in every place the copy says so", () => {
    expect(en.Demo.notice).toContain("6 hours");
    expect(ar.Demo.notice).toContain("6 ساعات");
    expect(en.Demo.notice).not.toContain("24 hours");
    expect(readFileSync("README.md", "utf8")).not.toMatch(/(deleted after|visitors live) 24 hours/);
  });
});
