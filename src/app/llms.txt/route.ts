import { buildLlmsTxt } from "@/lib/geo/llms";
import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";

// Built once at build time from the message files and NEXT_PUBLIC_SITE_URL.
export const dynamic = "force-static";

export function GET() {
  return new Response(buildLlmsTxt({ en, ar }, process.env.NEXT_PUBLIC_SITE_URL ?? ""), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
