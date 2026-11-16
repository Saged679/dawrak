import { renderAppIcon } from "@/lib/brand/icon-image";

export const dynamic = "force-static";

export function GET() {
  return renderAppIcon(512);
}
