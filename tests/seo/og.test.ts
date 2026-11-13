import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { OG_SIZE, renderOgImage } from "@/lib/seo/og";

const PNG = [0x89, 0x50, 0x4e, 0x47];

describe("og image", () => {
  for (const [locale, m] of [["ar", ar], ["en", en]] as const) {
    it(`renders a 1200x630 PNG in ${locale}`, async () => {
      const res = await renderOgImage({
        locale,
        brand: m.Seo.siteName,
        title: m.Seo.landing.ogHeadline,
        subtitle: m.Seo.landing.ogSub,
        badge: m.Seo.clinic.ogDemo,
      });
      expect(res.headers.get("content-type")).toBe("image/png");
      const buf = new Uint8Array(await res.arrayBuffer());
      expect([...buf.slice(0, 4)]).toEqual(PNG);
      const dv = new DataView(buf.buffer);
      expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([OG_SIZE.width, OG_SIZE.height]);
      if (process.env.OG_OUT) writeFileSync(`${process.env.OG_OUT}-${locale}.png`, buf);
    }, 30_000);
  }
});
