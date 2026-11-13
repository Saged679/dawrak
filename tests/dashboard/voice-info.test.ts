import { describe, expect, it } from "vitest";
import { voiceInfo } from "@/lib/dashboard/voice-info";

describe("voiceInfo (dashboard voice-note marker)", () => {
  it("recognises a voice turn and its duration", () => {
    expect(voiceInfo({ type: "audio", mediaType: "audio/wav", durationSeconds: 12 })).toEqual({ seconds: 12 });
    expect(voiceInfo({ type: "audio", durationSeconds: null })).toEqual({ seconds: null });
  });
  it("ignores text turns and junk", () => {
    for (const v of [null, undefined, "audio", 5, {}, { type: "text" }]) expect(voiceInfo(v)).toBeNull();
  });
});
