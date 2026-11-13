import { VOICE } from "./limits";

/** 44-byte canonical header + little-endian 16-bit PCM. */
export function encodeWav(pcm: Int16Array, sampleRate: number = VOICE.sampleRate, channels = 1): ArrayBuffer {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true);
  return buf;
}

export function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** `bars` values in 0..1 (max abs per bucket, normalised to the loudest bucket). */
export function computePeaks(f: Float32Array, bars = 36): number[] {
  const peaks = new Array<number>(bars).fill(0);
  if (f.length === 0) return peaks;
  const size = f.length / bars;
  let max = 0;
  for (let b = 0; b < bars; b++) {
    let m = 0;
    for (let i = Math.floor(b * size); i < Math.min(f.length, Math.floor((b + 1) * size)); i++) {
      m = Math.max(m, Math.abs(f[i]));
    }
    peaks[b] = m;
    max = Math.max(max, m);
  }
  return max > 0 ? peaks.map((p) => Math.max(0.08, p / max)) : peaks.map(() => 0.08);
}

export type WavHeader = {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** declared bytes of the data chunk */
  dataBytes: number;
  /** offset of the first PCM byte */
  dataOffset: number;
  durationSeconds: number;
};

/** Parses a PCM WAV; returns an error code instead of throwing. Data may not be truncated. */
export function parseWav(bytes: Uint8Array): { ok: true; header: WavHeader } | { ok: false; reason: string } {
  if (bytes.length < 44) return { ok: false, reason: "too_short" };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return { ok: false, reason: "not_wav" };
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.length) return { ok: false, reason: "bad_fmt" };
      if (v.getUint16(body, true) !== 1) return { ok: false, reason: "not_pcm" };
      fmt = { channels: v.getUint16(body + 2, true), sampleRate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!fmt) return { ok: false, reason: "bad_fmt" };
      if (body + size > bytes.length) return { ok: false, reason: "truncated" };
      const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
      if (!(bytesPerSec > 0)) return { ok: false, reason: "bad_fmt" };
      return {
        ok: true,
        header: {
          channels: fmt.channels,
          sampleRate: fmt.sampleRate,
          bitsPerSample: fmt.bits,
          dataBytes: size,
          dataOffset: body,
          durationSeconds: size / bytesPerSec,
        },
      };
    }
    o = body + size + (size % 2);
  }
  return { ok: false, reason: "no_data" };
}
