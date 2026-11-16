import { pngToIco, renderPlainIcon } from "@/lib/brand/icon-image";

export const dynamic = "force-static";

// Browsers still request /favicon.ico regardless of <link rel=icon>. Same mark as icon.svg, 48px PNG in an ICO container.
export async function GET() {
  const png = new Uint8Array(await renderPlainIcon(48).arrayBuffer());
  return new Response(pngToIco(png, 48) as BodyInit, {
    headers: {
      "content-type": "image/x-icon",
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
