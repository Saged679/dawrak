import { NextResponse } from "next/server";
import { getPaymentProvider } from "@/lib/payments";
import { processPaymentEvent } from "@/lib/payments/process";
import { supabasePaymentStore } from "@/lib/payments/store";
import { WebhookAuthError, WebhookFormatError } from "@/lib/payments/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 64 * 1024;

/**
 * Moyasar webhook receiver (docs: https://docs.moyasar.com/api/other/webhooks/webhook-reference).
 * Order: size cap -> authenticate (constant-time secret_token check, 401 before any other work)
 * -> fetch the payment from Moyasar's API and settle atomically (settle_payment, idempotent).
 * 2xx = handled or deliberately ignored (no retry needed); 5xx = we could not reach Moyasar or
 * the database, so Moyasar's retry schedule (1m,10m,30m,1h,2h) gets another go.
 * Logs event ids and outcomes only: never the body, the secret token or card data.
 */
export async function POST(req: Request) {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return NextResponse.json({ error: "too_large" }, { status: 413 });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "too_large" }, { status: 413 });

  let provider;
  try {
    provider = getPaymentProvider();
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }

  let event;
  try {
    event = provider.verifyAndParseWebhook(raw);
  } catch (e) {
    if (e instanceof WebhookAuthError) {
      console.warn("payment_webhook_rejected", "unauthorized");
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (e instanceof WebhookFormatError) {
      return NextResponse.json({ error: "malformed" }, { status: 400 });
    }
    return NextResponse.json({ error: "error" }, { status: 500 });
  }

  if (event.type === "webhook_verification") {
    // Authenticated. The 6-digit code is what you type into Moyasar to activate the webhook
    // (it is a one-time code, not a credential). Read it from the server log.
    console.info("payment_webhook_verification_code", event.verificationCode ?? "missing");
    return NextResponse.json({ ok: true });
  }

  try {
    const result = await processPaymentEvent(provider, supabasePaymentStore(), event, (msg, f) =>
      console.info(msg, f),
    );
    return NextResponse.json({ ok: true, result: result.kind });
  } catch (e) {
    console.error("payment_webhook_error", event.eventId, e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "retry" }, { status: 500 });
  }
}
