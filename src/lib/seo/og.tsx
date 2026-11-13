import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { Locale } from "@/i18n/routing";

export const OG_SIZE = { width: 1200, height: 630 };

// IBM Plex Sans Arabic Bold (OFL), woff files kept in the repo: no network fetch at runtime.
// ImageResponse cannot read woff2, so the .woff builds from @fontsource are used.
let fontsPromise: Promise<{ name: string; data: Buffer; weight: 700; style: "normal" }[]> | null = null;
function loadFonts() {
  fontsPromise ??= Promise.all(
    ["plex-ar-700.woff", "plex-lat-700.woff"].map(async (f) => ({
      name: "Plex",
      data: await readFile(join(process.cwd(), "src/lib/seo/fonts", f)),
      weight: 700 as const,
      style: "normal" as const,
    })),
  );
  return fontsPromise;
}

/**
 * Satori joins Arabic letters correctly but lays words out left to right whatever `direction` says.
 * For Arabic each word becomes its own flex item in a wrapping row-reverse, which gives the right
 * visual order and right-aligned wrapping.
 */
function Text({ text, rtl, size, color }: { text: string; rtl: boolean; size: number; color?: string }) {
  if (!rtl) return <div style={{ display: "flex", fontSize: size, color, lineHeight: 1.25 }}>{text}</div>;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row-reverse",
        flexWrap: "wrap",
        columnGap: size * 0.28,
        fontSize: size,
        color,
        lineHeight: 1.35,
      }}
    >
      {text.split(/\s+/).filter(Boolean).map((w, i) => (
        <div key={i} style={{ display: "flex" }}>
          {w}
        </div>
      ))}
    </div>
  );
}

type OgArgs = {
  locale: Locale;
  brand: string;
  title: string;
  subtitle: string;
  badge?: string;
};

/** 1200x630 brand card. Text direction follows the locale; the font has Arabic joining forms. */
export async function renderOgImage({ locale, brand, title, subtitle, badge }: OgArgs) {
  const rtl = locale === "ar";
  const fonts = await loadFonts();
  const titleSize = [...title].length > 40 ? 64 : 80;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#F6F1E7",
          color: "#17233B",
          fontFamily: "Plex",
          direction: rtl ? "rtl" : "ltr",
        }}
      >
        <div style={{ display: "flex", flexDirection: rtl ? "row-reverse" : "row", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 18,
              background: "#1F3FBF",
              color: "#fff",
              fontSize: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {rtl ? "د" : "D"}
          </div>
          <div style={{ fontSize: 44, display: "flex" }}>{brand}</div>
          {badge ? (
            <div
              style={{
                display: "flex",
                fontSize: 28,
                padding: "6px 20px",
                borderRadius: 999,
                background: "#F4B13E",
                color: "#17233B",
              }}
            >
              <Text text={badge} rtl={rtl} size={28} />
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24, alignItems: rtl ? "flex-end" : "flex-start", textAlign: rtl ? "right" : "left" }}>
          <Text text={title} rtl={rtl} size={titleSize} />
          <Text text={subtitle} rtl={rtl} size={36} color="#4A5568" />
        </div>
        <div style={{ display: "flex", height: 12, width: 240, borderRadius: 6, background: "#F4B13E", alignSelf: rtl ? "flex-end" : "flex-start" }} />
      </div>
    ),
    { ...OG_SIZE, fonts },
  );
}
