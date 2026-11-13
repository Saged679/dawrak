/** messages.parts of a voice turn is {type:"audio", mediaType, durationSeconds}; the audio itself is never stored. */
export type VoiceInfo = { seconds: number | null };
export function voiceInfo(parts: unknown): VoiceInfo | null {
  if (!parts || typeof parts !== "object" || (parts as { type?: unknown }).type !== "audio") return null;
  const d = (parts as { durationSeconds?: unknown }).durationSeconds;
  return { seconds: typeof d === "number" && Number.isFinite(d) ? d : null };
}
