/**
 * Voice note limits, shared by the widget (recorder) and the server (validation).
 *
 * The widget always converts to 16 kHz mono 16-bit PCM WAV (32,000 bytes/s). Gemini's audio guide
 * (https://ai.google.dev/gemini-api/docs/audio) lists audio/wav, audio/webm, audio/ogg, audio/mp3,
 * audio/mpeg, audio/aac, audio/flac, audio/aiff, audio/m4a ... but NOT audio/mp4, which is what
 * Safari/iOS MediaRecorder produces, so WAV is the one format every browser can be converted to.
 * 25 s of that is 800,044 bytes, 1,066,728 base64 characters: under the ~1 MB request budget.
 */
export const VOICE = {
  /** hard stop of the recorder */
  maxSeconds: 25,
  /** server tolerance on top of maxSeconds (timer granularity, encoder rounding) */
  serverMaxSeconds: 26,
  minSeconds: 0.5,
  sampleRate: 16_000,
  bitsPerSample: 16,
  channels: 1,
  /** decoded size cap: 26 s of 16 kHz mono 16-bit WAV is 832,044 bytes */
  maxBytes: 900_000,
} as const;

/** base64 length of `bytes` bytes, padding included. */
export const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;
