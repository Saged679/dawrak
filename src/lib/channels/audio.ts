import { VOICE } from "@/lib/audio/limits";
import { parseWav } from "@/lib/audio/wav";
import { ChannelError } from "./types";

/**
 * Only WAV is accepted (L2). The widget converts every recording to 16-bit PCM WAV in the browser, and WAV is
 * the one container whose header we parse completely (format, sample rate, length), so nothing a client sends
 * as webm/ogg/mp3/aac/flac ever reaches the model. Other types are refused with audio_unsupported.
 */
export const AUDIO_TYPES = { "audio/wav": "wav" } as const;

/** `audio/x-wav` and `audio/wave` (and parameters) -> `audio/wav`. null for any other type. */
export function normalizeAudioType(declared: string): keyof typeof AUDIO_TYPES | null {
  const base = declared.split(";")[0].trim().toLowerCase();
  const t = base === "audio/x-wav" || base === "audio/wave" ? "audio/wav" : base;
  return t in AUDIO_TYPES ? (t as keyof typeof AUDIO_TYPES) : null;
}

function isRiffWave(b: Uint8Array): boolean {
  const s = (o: number, t: string) => t.split("").every((c, i) => b[o + i] === c.charCodeAt(0));
  return b.length >= 12 && s(0, "RIFF") && s(8, "WAVE");
}

export type ValidAudio = { data: string; mediaType: string; durationSeconds: number | null };

/**
 * Strict check of an untrusted audio part. `base64` already passed zod's base64 + length checks.
 * Throws ChannelError with a code the widget maps to a message.
 */
export function validateAudio(base64: string, declaredType: string): ValidAudio {
  const type = normalizeAudioType(declaredType);
  if (!type) throw new ChannelError("audio_unsupported", "This audio format is not supported.", 415);
  const bytes = Buffer.from(base64, "base64");
  // Buffer.from silently drops invalid characters: a re-encode that differs means the input was not clean base64.
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
    throw new ChannelError("audio_invalid", "The audio could not be read.");
  }
  if (bytes.length > VOICE.maxBytes) throw new ChannelError("payload_too_large", "Message is too large.", 413);
  const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isRiffWave(u8)) throw new ChannelError("audio_invalid", "The audio does not match its declared format.");

  const w = parseWav(u8);
  if (!w.ok) throw new ChannelError("audio_invalid", "The audio could not be read.");
  const h = w.header;
  if (h.bitsPerSample !== 16 || h.channels < 1 || h.channels > 2 || h.sampleRate < 8000 || h.sampleRate > 48000) {
    throw new ChannelError("audio_invalid", "The audio could not be read.");
  }
  if (h.durationSeconds > VOICE.serverMaxSeconds) {
    throw new ChannelError("audio_too_long", `Voice notes can be up to ${VOICE.maxSeconds} seconds.`, 413);
  }
  if (h.durationSeconds < VOICE.minSeconds / 2) throw new ChannelError("audio_invalid", "The audio is too short.");
  return { data: base64, mediaType: type, durationSeconds: h.durationSeconds };
}
