import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron/auth";
import { getClientIp } from "@/lib/db/client-ip";
import { getServiceClient } from "@/lib/db/client";
import { rateLimitOk } from "@/lib/db/public";
import { reembedMissing } from "@/lib/agent/reembed";
import { purgeExpiredDemoUsers } from "@/lib/demo/purge";
import { mailProviderFor } from "@/lib/mail";
import { manageUrl } from "@/lib/mail/links";
import { dispatchDueReminders } from "@/lib/reminders/dispatch";
import { supabaseReminderStore } from "@/lib/reminders/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Reminder dispatcher. Called every 30 minutes by .github/workflows/reminders.yml (POST) and once a
 * day by the Vercel cron in vercel.json (Vercel sends GET with the same Bearer CRON_SECRET).
 * Authentication comes first and fails closed; nothing touches the database before it passes.
 */
async function handle(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    try {
      const ip = getClientIp(request.headers);
      if (!(await rateLimitOk(`ip:${ip}:cronfail`, 30, "10 minutes"))) {
        return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
      }
    } catch {
      // the limiter is best effort here; the answer is a 401 either way
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  try {
    const db = getServiceClient();
    // Backup for the pg_cron job (every minute): release unpaid holds whose window passed.
    const { error: expireError } = await db.rpc("expire_pending_bookings");
    if (expireError) console.error("cron_expire_error", expireError.code ?? "unknown");

    const summary = await dispatchDueReminders({
      store: supabaseReminderStore(db),
      providerFor: mailProviderFor,
      manageUrl,
      limit: 20,
      delayMs: 600,
    });

    const { error: purgeError } = await db.rpc("purge_demo_outbox");
    if (purgeError) console.error("cron_purge_error", purgeError.code ?? "unknown");
    const { error: chatPurgeError } = await db.rpc("purge_chat_agent_data");
    if (chatPurgeError) console.error("cron_chat_purge_error", chatPurgeError.code ?? "unknown");
    // Backup for the pg_cron purge: expired demo visitors via the Auth Admin API (idempotent).
    try {
      await purgeExpiredDemoUsers(db);
    } catch (e) {
      console.error("cron_demo_purge_error", e instanceof Error ? e.message : "unknown");
    }
    // Best effort: give knowledge chunks without an embedding (seeded demo content) their vector, a few per run.
    // Skips without a Gemini key or on quota errors; never fails the cron and never logs content.
    let reembed: Awaited<ReturnType<typeof reembedMissing>> = { embedded: 0, skipped: "error" };
    try {
      reembed = await reembedMissing(db);
    } catch {
      // reembedMissing never throws; this is only a belt for the "never fails the cron" rule
    }
    return NextResponse.json({ ok: true, ...summary, reembed }, { headers: NO_STORE });
  } catch (e) {
    console.error("cron_reminders_error", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ ok: false }, { status: 500, headers: NO_STORE });
  }
}

export const GET = handle;
export const POST = handle;
