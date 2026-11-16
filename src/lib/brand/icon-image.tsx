import { ImageResponse } from "next/og";
import { logoDataUri, type LogoSvgOptions } from "./logo-svg";

export const APP_ICON_TILE: LogoSvgOptions = { tone: "on-cobalt", tile: { scale: 0.62 } };

/** Square PNG of the mark on a cobalt tile (apple-icon, manifest icons; maskable-safe margin). */
export function renderAppIcon(size: number) {
  return new ImageResponse(
    (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logoDataUri({ ...APP_ICON_TILE, size })} width={size} height={size} alt="" />
    ),
    { width: size, height: size },
  );
}

/** Transparent PNG of the plain colour mark (favicon.ico, JSON-LD logo). */
export function renderPlainIcon(size: number, opts: LogoSvgOptions = {}) {
  return new ImageResponse(
    (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logoDataUri({ ...opts, size })} width={size} height={size} alt="" />
    ),
    { width: size, height: size },
  );
}

/** Wraps one PNG in a single-image ICO container (PNG-in-ICO is supported by every current browser). */
export function pngToIco(png: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(22 + png.length);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0, true); // reserved
  v.setUint16(2, 1, true); // type: icon
  v.setUint16(4, 1, true); // image count
  out[6] = size >= 256 ? 0 : size; // width
  out[7] = size >= 256 ? 0 : size; // height
  out[8] = 0; // palette
  out[9] = 0; // reserved
  v.setUint16(10, 1, true); // colour planes
  v.setUint16(12, 32, true); // bits per pixel
  v.setUint32(14, png.length, true); // image size
  v.setUint32(18, 22, true); // image offset
  out.set(png, 22);
  return out;
}
