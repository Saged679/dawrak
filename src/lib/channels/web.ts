import { z } from "zod";
import { VOICE, base64Length } from "@/lib/audio/limits";
import { normalizeAudioType, validateAudio } from "./audio";
import { ChannelError, type ChannelAdapter, type InboundMessage } from "./types";

export const WEB_LIMITS = {
  maxTextChars: 500,
  /** base64 chars of a voice note (25 s of 16 kHz mono WAV is about 1.07 M; see src/lib/audio/limits.ts) */
  maxAudioBase64Chars: base64Length(VOICE.maxBytes),
  maxBodyBytes: 1_600_000,
} as const;

export const webBodySchema = z.strictObject({
  tenantSlug: z
    .string()
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  conversationId: z.uuid().optional(),
  locale: z.enum(["ar", "en"]).default("ar"),
  message: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("text"), text: z.string().trim().min(1).max(WEB_LIMITS.maxTextChars) }),
    z.strictObject({
      type: z.literal("audio"),
      data: z.base64().max(WEB_LIMITS.maxAudioBase64Chars),
      mediaType: z
        .string()
        .max(100)
        .refine((t) => normalizeAudioType(t) !== null),
    }),
  ]),
});

/** Reads the body but gives up as soon as it passes `max` bytes (no full buffering of huge uploads). */
async function readLimited(req: Request, max: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ChannelError("payload_too_large", "Message is too large.", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const webChannel: ChannelAdapter<Request, Response> = {
  channel: "web",

  async parseInbound(req) {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > WEB_LIMITS.maxBodyBytes) {
      throw new ChannelError("payload_too_large", "Message is too large.", 413);
    }
    const raw = await readLimited(req, WEB_LIMITS.maxBodyBytes);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ChannelError("invalid_json", "Request body must be JSON.");
    }
    const parsed = webBodySchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues;
      const audioIssue = (key: string) => issues.some((i) => i.path[0] === "message" && i.path[1] === key);
      if (issues.some((i) => i.path[0] === "message" && i.path[1] === "data" && i.code === "too_big")) {
        throw new ChannelError("payload_too_large", "Message is too large.", 413);
      }
      if (audioIssue("mediaType")) throw new ChannelError("audio_unsupported", "This audio format is not supported.", 415);
      if (audioIssue("data")) throw new ChannelError("audio_invalid", "The audio could not be read.");
      const tooLong = issues.some((i) => i.code === "too_big");
      throw new ChannelError(
        tooLong ? "message_too_long" : "invalid_request",
        tooLong ? `Message is too long (max ${WEB_LIMITS.maxTextChars} characters).` : "Invalid request.",
        tooLong ? 413 : 400,
      );
    }
    const b = parsed.data;
    const out: InboundMessage = {
      channel: "web",
      tenant: { slug: b.tenantSlug },
      conversationId: b.conversationId,
      locale: b.locale,
      message:
        b.message.type === "text"
          ? { type: "text", text: b.message.text }
          : { type: "audio", ...validateAudio(b.message.data, b.message.mediaType) },
    };
    return out;
  },

  respond(result, { conversationId }) {
    // AI SDK UI message stream (works with useChat via a custom transport); tool calls are included.
    return result.toUIMessageStreamResponse({ headers: { "x-conversation-id": conversationId } });
  },
};
