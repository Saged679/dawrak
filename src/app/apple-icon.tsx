import { renderAppIcon } from "@/lib/brand/icon-image";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Full-bleed square tile: iOS applies its own rounded mask.
export default function AppleIcon() {
  return renderAppIcon(180);
}
