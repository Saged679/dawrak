/**
 * WhatsApp channel: STUB, NOT WIRED. It documents how a WhatsApp Cloud API webhook maps onto the
 * same agent core the web chat uses. Nothing here is imported by any route.
 *
 * Wiring plan (Meta WhatsApp Cloud API; service conversations are free of charge):
 *
 * 1. Route `src/app/api/whatsapp/route.ts`
 *      GET  : Meta verification handshake (hub.mode / hub.verify_token / hub.challenge).
 *      POST : verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret) BEFORE
 *             parsing, then call `whatsappChannel.parseInbound(payload)`.
 * 2. Tenant: map `metadata.phone_number_id` to a tenant id (new table, e.g. tenant_channels).
 *    Never take the tenant from message content.
 * 3. Same pipeline as `src/app/api/chat/route.ts`: rate limit (key on the sender phone), then
 *    getOrCreateConversation({ channel: "whatsapp", externalId: phone }), loadHistory, runAgent(...),
 *    and finally `whatsappChannel.respond(result)`.
 * 4. Audio: download the media id with the Graph API (needs the access token), then pass
 *    `{ type: "audio", data: bytes, mediaType: "audio/ogg" }` to the core; Gemini takes it as a file part.
 * 5. Reply: WhatsApp cannot stream, so `respond` waits for the full text (`await result.text`) and
 *    POSTs it to `/{phone_number_id}/messages` as a text message, inside the 24 h service window.
 * 6. Identity: the sender phone number is verified by WhatsApp, so a later change can link the
 *    conversation to the customer with that phone (on web chat the phone is self-declared, so the
 *    tools only link a conversation to a customer created inside it).
 *
 * Env vars needed when wired (not in .env.example until then):
 *    WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_ACCESS_TOKEN
 */
import { ChannelError, type ChannelAdapter, type InboundMessage } from "./types";

/** The subset of the Cloud API webhook payload we use. */
export type WhatsAppWebhook = {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: {
          from: string;
          id: string;
          type: "text" | "audio" | string;
          text?: { body: string };
          audio?: { id: string; mime_type: string };
        }[];
      };
    }[];
  }[];
};

export const whatsappChannel: ChannelAdapter<WhatsAppWebhook, Promise<void>> = {
  channel: "whatsapp",

  async parseInbound(payload) {
    const value = payload.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    const phoneNumberId = value?.metadata?.phone_number_id;
    if (!msg || !phoneNumberId) throw new ChannelError("no_message", "Nothing to process.", 200);

    // TODO(wiring): resolve phoneNumberId to a tenant id; the id below is a placeholder.
    const tenant = { id: phoneNumberId };
    if (msg.type === "text" && msg.text) {
      const out: InboundMessage = {
        channel: "whatsapp",
        tenant,
        externalId: msg.from,
        locale: "ar",
        message: { type: "text", text: msg.text.body.slice(0, 500) },
      };
      return out;
    }
    // TODO(wiring): for type "audio", download msg.audio.id via the Graph API and pass the bytes.
    throw new ChannelError("unsupported_type", "Unsupported WhatsApp message type.", 200);
  },

  async respond(result) {
    const text = await result.text;
    // TODO(wiring): POST `text` to https://graph.facebook.com/v21.0/{phone_number_id}/messages
    void text;
  },
};
