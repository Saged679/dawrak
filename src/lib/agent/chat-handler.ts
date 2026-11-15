import type { LanguageModel } from "ai";
import { getClientIp } from "@/lib/db/client-ip";
import { ChannelError, type ChannelAdapter } from "@/lib/channels/types";
import { webChannel } from "@/lib/channels/web";
import { hasGeminiKey } from "./key-pool";
import { getOrCreateConversation, loadHistory, saveMessage } from "./conversation";
import { createAgentDb } from "./db";
import { checkAudioIpLimit, checkAudioTenantLimit, checkIpDayLimit, checkIpLimit, checkTenantLimit } from "./rate-limit";
import { createAfterBooking, type SendBookingEmail } from "./booking-mail";
import { e2eMockEnabled } from "./mock-gate";
import { modelIdsFromEnv, sharedQuotaMemo, type AssistantQuotaError, type QuotaMemo } from "./models";
import { runAgent } from "./run-agent";
import {
  chatOwnerHash,
  chatSessionSetCookie,
  demoSessionSetCookie,
  hashDemoSession,
  newDemoSessionValue,
  readChatSessionFromHeader,
  readDemoSessionFromHeader,
} from "@/lib/demo/session";
import type { AgentDb } from "./types";

export type ChatDeps = {
  db?: AgentDb;
  model?: LanguageModel;
  embedQuery?: (text: string) => Promise<number[]>;
  channel?: ChannelAdapter<Request, Response>;
  /** Replaces the booking confirmation mailer (tests). */
  sendBookingEmail?: SendBookingEmail;
  /** Quota memo and model ids for the "every model is exhausted" fast path (tests). */
  quotaMemo?: QuotaMemo;
  modelIds?: string[];
};

/**
 * Every model of the chain is known to be out of quota (per-instance memo): answer 503 without touching the
 * model OR the visitor's rate limits. 503, not 429: the visitor did nothing wrong, the upstream free quota
 * is used up, and 429 is reserved for the visitor's own limits. A per-minute exhaustion is "assistant_busy".
 */
export function quotaResponse(e: AssistantQuotaError) {
  return errorResponse(
    503,
    e.code,
    e.code === "assistant_busy"
      ? "The assistant is busy for a moment. Please try again shortly."
      : "The assistant reached today's free limit. Booking through the form still works.",
    { retryAfterSeconds: e.retryAfterSeconds },
  );
}

/**
 * Keeps the response stream open until the assistant message (and the "delivered" mark of a pending summary) is
 * persisted. Without this the browser sees the stream end first, the visitor can tap Confirm before the write
 * lands (the confirming message would then be stored BEFORE the summary message and the gate drops it), and on
 * serverless the function can be frozen right after the response, losing the write. Bounded wait: a stuck write
 * never hangs the stream.
 */
export function holdUntilPersisted(res: Response, persisted: () => Promise<void>, maxMs = 15_000): Response {
  if (!res.body) return res;
  const wait = new TransformStream<Uint8Array, Uint8Array>({
    async flush() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([persisted().catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, maxMs)))]);
      clearTimeout(timer);
    },
  });
  return new Response(res.body.pipeThrough(wait), { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Text stored in messages.content for a voice turn (also what later turns see as history). */
export function voiceNoteLabel(durationSeconds?: number | null): string {
  return durationSeconds == null ? "[voice note]" : `[voice note, ${Math.max(1, Math.round(durationSeconds))} s]`;
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: { retryAfterSeconds?: number } = {},
) {
  return Response.json(
    { error: { code, message, ...extra } },
    { status, headers: extra.retryAfterSeconds ? { "Retry-After": String(extra.retryAfterSeconds) } : undefined },
  );
}

/**
 * Web chat pipeline: IP rate limit -> parse/validate -> resolve tenant -> tenant daily limit ->
 * persist -> model. The model is never reached when a limit or validation fails.
 */
export async function handleChat(req: Request, deps: ChatDeps = {}): Promise<Response> {
  const channel = deps.channel ?? webChannel;

  let db: AgentDb;
  try {
    db = deps.db ?? createAgentDb();
  } catch {
    return errorResponse(503, "not_configured", "The assistant is not configured yet.");
  }
  const model = deps.model ?? (e2eMockEnabled(req.headers) ? await (await import("./mock-model")).mockChatModel(req) : null) ?? undefined;
  if (!model && !hasGeminiKey()) {
    return errorResponse(503, "not_configured", "The assistant is not configured yet.");
  }

  // Real models only (an injected/mock model has its own chain and memo inside runAgent).
  if (!model) {
    const exhausted = (deps.quotaMemo ?? sharedQuotaMemo).allBlocked(deps.modelIds ?? modelIdsFromEnv());
    if (exhausted) return quotaResponse(exhausted);
  }

  try {
    // Request-shape checks first: a cross-site or malformed request never consumes a visitor's limits.
    channel.precheck?.(req);

    const ipLimit = await checkIpLimit(db, getClientIp(req.headers));
    if (!ipLimit.ok) {
      return errorResponse(429, "rate_limited", "Too many messages. Please wait a few minutes and try again.", {
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      });
    }

    // L3: per-IP daily cap besides the 10-minute window and the tenant cap (one visitor cannot burn the tenant's day)
    const ipDay = await checkIpDayLimit(db, getClientIp(req.headers));
    if (!ipDay.ok) {
      return errorResponse(429, "ip_daily_limit", "You have reached today's message limit. Please try again tomorrow.", {
        retryAfterSeconds: ipDay.retryAfterSeconds,
      });
    }

    const inbound = await channel.parseInbound(req);
    if (!("slug" in inbound.tenant)) throw new ChannelError("invalid_request", "Invalid request.");

    const { data: rows, error: tErr } = await db.rpc("public_get_tenant", { p_slug: inbound.tenant.slug });
    if (tErr) throw tErr;
    const tenant = (rows as { id: string; slug?: string; is_demo?: boolean }[] | null)?.[0];
    if (!tenant) return errorResponse(404, "tenant_not_found", "Business not found.");

    const tenantLimit = await checkTenantLimit(db, tenant.id);
    if (!tenantLimit.ok) {
      return errorResponse(429, "tenant_daily_limit", "This assistant has reached its daily limit. Please try again tomorrow.", {
        retryAfterSeconds: tenantLimit.retryAfterSeconds,
      });
    }

    if (inbound.message.type === "audio") {
      const aIp = await checkAudioIpLimit(db, getClientIp(req.headers));
      if (!aIp.ok) {
        return errorResponse(429, "audio_rate_limited", "Too many voice notes. Please type your message or wait a few minutes.", {
          retryAfterSeconds: aIp.retryAfterSeconds,
        });
      }
      const aTenant = await checkAudioTenantLimit(db, tenant.id);
      if (!aTenant.ok) {
        return errorResponse(429, "audio_daily_limit", "Voice notes have reached the daily limit. Please type your message.", {
          retryAfterSeconds: aTenant.retryAfterSeconds,
        });
      }
    }

    // The visitor's httpOnly random session (the same cookie as the demo web booking form). It is created here,
    // before the stream starts, because headers cannot change once it has. Only its SHA-256 reaches the database;
    // the model never sees any of it. L5: a conversation can only be resumed by the session that created it, so a
    // conversation id alone (it is in a header and in localStorage) is not enough. Demo tenants also use the hash as the
    // data owner (per-visitor isolation) and for their mailbox.
    const isDemo = tenant.is_demo === true;
    let newCookie: string | null = null;
    let ownerHash: string;
    let sessionHash: string | null = null;
    if (isDemo) {
      let raw = readDemoSessionFromHeader(req.headers.get("cookie"));
      if (!raw) {
        raw = newDemoSessionValue();
        newCookie = demoSessionSetCookie(raw);
      }
      ownerHash = hashDemoSession(raw);
      sessionHash = ownerHash;
    } else {
      // Real tenants: a SEPARATE long-lived chat cookie, hashed per tenant, never the demo session (whose rows are purged
      // by hash) and never linkable across businesses.
      let raw = readChatSessionFromHeader(req.headers.get("cookie"));
      if (!raw) {
        raw = newDemoSessionValue();
        newCookie = chatSessionSetCookie(raw);
      }
      ownerHash = chatOwnerHash(raw, tenant.id);
    }
    const afterBooking = createAfterBooking({
      db,
      tenant: { id: tenant.id, slug: inbound.tenant.slug, is_demo: isDemo },
      locale: inbound.locale,
      sessionHash,
      send: deps.sendBookingEmail,
    });

    const conversationId = await getOrCreateConversation(db, {
      tenantId: tenant.id,
      channel: "web",
      conversationId: inbound.conversationId,
      sessionHash: ownerHash,
    });
    const history = await loadHistory(db, tenant.id, conversationId);
    await saveMessage(db, {
      tenantId: tenant.id,
      conversationId,
      role: "user",
      // Only a placeholder and metadata are stored, never the audio itself.
      content: inbound.message.type === "text" ? inbound.message.text : voiceNoteLabel(inbound.message.durationSeconds),
      parts:
        inbound.message.type === "audio"
          ? {
              type: "audio",
              mediaType: inbound.message.mediaType,
              durationSeconds:
                inbound.message.durationSeconds == null ? null : Math.max(1, Math.round(inbound.message.durationSeconds)),
            }
          : null,
    });

    let persisted: Promise<void> = Promise.resolve();
    const result = await runAgent({
      registerPersistence: (p) => void (persisted = p),
      tenantId: tenant.id,
      conversationId,
      sessionHash,
      message: inbound.message,
      locale: inbound.locale,
      history,
      onReply: async (text) => {
        if (text.trim()) return saveMessage(db, { tenantId: tenant.id, conversationId, role: "assistant", content: text });
      },
      afterBooking,
      deps: { db, model, embedQuery: deps.embedQuery },
    });
    const res = holdUntilPersisted(await channel.respond(result, { conversationId }), () => persisted);
    if (!newCookie) return res;
    const headers = new Headers(res.headers);
    headers.append("set-cookie", newCookie);
    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    if (e instanceof ChannelError) return errorResponse(e.status, e.code, e.message);
    console.error("chat_error", e instanceof Error ? e.message : e);
    return errorResponse(500, "internal_error", "Something went wrong. Please try again.");
  }
}
