import { describe, expect, it } from "vitest";
import { VOICE, base64Length } from "@/lib/audio/limits";
import { computePeaks, encodeWav, floatToInt16, parseWav } from "@/lib/audio/wav";

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

describe("encodeWav", () => {
  it("writes a canonical 44-byte header for known PCM", () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
    const buf = encodeWav(pcm, 16000);
    const b = new Uint8Array(buf);
    const v = new DataView(buf);
    expect(b.length).toBe(44 + 10);
    expect(ascii(b, 0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 10);
    expect(ascii(b, 8, 8)).toBe("WAVEfmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(b, 36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(10);
    expect([0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 1, -1, 32767, -32768]);
  });

  it("round-trips through parseWav and reports the duration", () => {
    const pcm = new Int16Array(VOICE.sampleRate * 2);
    const r = parseWav(new Uint8Array(encodeWav(pcm)));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.header).toMatchObject({ channels: 1, sampleRate: 16000, bitsPerSample: 16, dataBytes: 64000, dataOffset: 44 });
      expect(r.header.durationSeconds).toBeCloseTo(2, 5);
    }
  });

  it("keeps 25 s under the request budget (size numbers quoted in the report)", () => {
    const bytes = encodeWav(new Int16Array(VOICE.sampleRate * VOICE.maxSeconds)).byteLength;
    expect(bytes).toBe(800_044);
    expect(base64Length(bytes)).toBe(1_066_728);
    expect(bytes).toBeLessThan(VOICE.maxBytes);
  });

  it("floatToInt16 clamps and scales", () => {
    expect(Array.from(floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it("computePeaks gives n values in (0, 1], loudest bucket is 1", () => {
    const f = new Float32Array(3600);
    f[1800] = 0.5;
    const p = computePeaks(f, 36);
    expect(p).toHaveLength(36);
    expect(Math.max(...p)).toBe(1);
    expect(Math.min(...p)).toBeGreaterThan(0);
    expect(computePeaks(new Float32Array(0), 4)).toEqual([0, 0, 0, 0]);
  });
});

describe("parseWav rejects bad input", () => {
  const good = new Uint8Array(encodeWav(new Int16Array(1600)));
  it("not RIFF/WAVE, too short, truncated data, non-PCM", () => {
    expect(parseWav(new Uint8Array(10))).toEqual({ ok: false, reason: "too_short" });
    const notWav = good.slice();
    notWav[8] = 0x58;
    expect(parseWav(notWav)).toMatchObject({ ok: false, reason: "not_wav" });
    expect(parseWav(good.slice(0, good.length - 10))).toEqual({ ok: false, reason: "truncated" });
    const float = good.slice();
    float[20] = 3;
    expect(parseWav(float)).toEqual({ ok: false, reason: "not_pcm" });
  });
});
