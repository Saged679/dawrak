import { handleChat } from "@/lib/agent/chat-handler";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Web channel entry point. Body: see webBodySchema in src/lib/channels/web.ts. */
export async function POST(req: Request) {
  return handleChat(req);
}
