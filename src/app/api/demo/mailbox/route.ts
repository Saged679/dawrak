import { NextResponse, type NextRequest } from "next/server";
import { hashDemoSession, readDemoSessionFromHeader } from "@/lib/demo/session";
import { listMailbox } from "@/lib/demo/mailbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0", Vary: "Cookie" };

/**
 * Poll endpoint for /demo/mailbox. Same isolation as the page: the only key is the visitor's own httpOnly
 * session cookie (matched by hash). No cookie or a malformed one means an empty answer, never anyone
 * else's mail. It returns only counts and ids (no subjects, addresses or links); the page itself
 * renders the messages after a router refresh.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const raw = readDemoSessionFromHeader(request.headers.get("cookie"));
  if (!raw) return NextResponse.json({ count: 0, ids: [] }, { headers: NO_STORE });
  try {
    const rows = await listMailbox(hashDemoSession(raw));
    return NextResponse.json({ count: rows.length, ids: rows.map((r) => r.id) }, { headers: NO_STORE });
  } catch (e) {
    console.error("mailbox_poll_error", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
