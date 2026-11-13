import { VOICE } from "@/lib/audio/limits";
import { computePeaks, encodeWav, floatToInt16 } from "@/lib/audio/wav";

export type VoiceClip = { wav: Blob; peaks: number[]; durationMs: number };

type AudioCtor = new () => AudioContext;
type OfflineCtor = new (channels: number, length: number, rate: number) => OfflineAudioContext;

/**
 * Decodes whatever MediaRecorder produced (webm/opus, mp4/aac...) and renders it to 16 kHz mono
 * (the OfflineAudioContext does the down-mix and resample), then wraps it as 16-bit PCM WAV.
 */
export async function blobToWavClip(blob: Blob): Promise<VoiceClip> {
  const w = globalThis as unknown as {
    AudioContext?: AudioCtor;
    webkitAudioContext?: AudioCtor;
    OfflineAudioContext?: OfflineCtor;
    webkitOfflineAudioContext?: OfflineCtor;
  };
  const Ctx = w.AudioContext ?? w.webkitAudioContext;
  const Offline = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!Ctx || !Offline) throw new Error("no_audio_context");
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const seconds = Math.min(decoded.duration, VOICE.maxSeconds);
    const length = Math.max(1, Math.round(seconds * VOICE.sampleRate));
    const off = new Offline(1, length, VOICE.sampleRate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    const pcm = rendered.getChannelData(0);
    return {
      wav: new Blob([encodeWav(floatToInt16(pcm), VOICE.sampleRate)], { type: "audio/wav" }),
      peaks: computePeaks(pcm),
      durationMs: Math.round((pcm.length / VOICE.sampleRate) * 1000),
    };
  } finally {
    void ctx.close().catch(() => {});
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
