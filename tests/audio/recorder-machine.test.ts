import { describe, expect, it } from "vitest";
import {
  MAX_VOICE_MS,
  detectVoiceSupport,
  formatClock,
  initialVoiceState,
  mapMediaError,
  voiceReducer,
  type VoiceEvent,
  type VoiceState,
} from "@/components/chat/voice/machine";

const run = (events: VoiceEvent[], from: VoiceState = initialVoiceState) => events.reduce(voiceReducer, from);

describe("recorder state machine", () => {
  it("happy path: idle -> requesting -> recording -> processing -> preview -> idle (send)", () => {
    expect(run([{ type: "TAP_MIC" }])).toEqual({ status: "requesting" });
    expect(run([{ type: "TAP_MIC" }, { type: "GRANTED" }])).toEqual({ status: "recording", elapsedMs: 0 });
    expect(run([{ type: "TAP_MIC" }, { type: "GRANTED" }, { type: "TICK", elapsedMs: 3200 }])).toEqual({
      status: "recording",
      elapsedMs: 3200,
    });
    const processing = run([{ type: "TAP_MIC" }, { type: "GRANTED" }, { type: "STOP" }]);
    expect(processing).toEqual({ status: "processing", reason: "stop" });
    expect(run([{ type: "ENCODED", durationMs: 3000 }], processing)).toEqual({ status: "preview", durationMs: 3000 });
    expect(run([{ type: "RESET" }], { status: "preview", durationMs: 3000 })).toEqual({ status: "idle" });
  });

  it("hard stops at the 25 s limit", () => {
    const rec = run([{ type: "TAP_MIC" }, { type: "GRANTED" }]);
    expect(MAX_VOICE_MS).toBe(25_000);
    expect(voiceReducer(rec, { type: "TICK", elapsedMs: 24_900 })).toEqual({ status: "recording", elapsedMs: 24_900 });
    expect(voiceReducer(rec, { type: "TICK", elapsedMs: 25_000 })).toEqual({ status: "processing", reason: "limit" });
    expect(voiceReducer(rec, { type: "TICK", elapsedMs: 40_000 })).toEqual({ status: "processing", reason: "limit" });
  });

  it("cancel works from requesting, recording, processing and preview", () => {
    for (const s of [
      { status: "requesting" },
      { status: "recording", elapsedMs: 10 },
      { status: "processing", reason: "stop" },
      { status: "preview", durationMs: 2000 },
    ] as VoiceState[]) {
      expect(voiceReducer(s, { type: "CANCEL" })).toEqual({ status: "idle" });
    }
  });

  it("errors: denied, then a new tap retries; too short recordings are rejected", () => {
    const denied = run([{ type: "TAP_MIC" }, { type: "FAILED", error: "denied" }]);
    expect(denied).toEqual({ status: "error", error: "denied" });
    expect(voiceReducer(denied, { type: "TAP_MIC" })).toEqual({ status: "requesting" });
    expect(voiceReducer({ status: "processing", reason: "stop" }, { type: "ENCODED", durationMs: 100 })).toEqual({
      status: "error",
      error: "too_short",
    });
    expect(voiceReducer({ status: "idle" }, { type: "FAILED", error: "unsupported" })).toEqual({
      status: "error",
      error: "unsupported",
    });
  });

  it("ignores events that do not apply (late results after cancel, double taps)", () => {
    expect(voiceReducer({ status: "idle" }, { type: "GRANTED" })).toEqual({ status: "idle" });
    expect(voiceReducer({ status: "idle" }, { type: "ENCODED", durationMs: 5000 })).toEqual({ status: "idle" });
    expect(voiceReducer({ status: "idle" }, { type: "TICK", elapsedMs: 5000 })).toEqual({ status: "idle" });
    const rec: VoiceState = { status: "recording", elapsedMs: 1 };
    expect(voiceReducer(rec, { type: "TAP_MIC" })).toBe(rec);
    expect(voiceReducer({ status: "preview", durationMs: 1000 }, { type: "STOP" })).toEqual({
      status: "preview",
      durationMs: 1000,
    });
  });
});

describe("feature detection", () => {
  const ok = {
    isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia: () => {} } },
    MediaRecorder: function () {},
    AudioContext: function () {},
    OfflineAudioContext: function () {},
  };
  it("ok / insecure / unsupported", () => {
    expect(detectVoiceSupport(ok)).toBe("ok");
    expect(detectVoiceSupport({ ...ok, isSecureContext: false })).toBe("insecure");
    expect(detectVoiceSupport({ ...ok, MediaRecorder: undefined })).toBe("unsupported");
    expect(detectVoiceSupport({ ...ok, navigator: {} })).toBe("unsupported");
    expect(detectVoiceSupport({ ...ok, OfflineAudioContext: undefined })).toBe("unsupported");
  });
  it("maps getUserMedia errors", () => {
    expect(mapMediaError({ name: "NotAllowedError" })).toBe("denied");
    expect(mapMediaError({ name: "NotFoundError" })).toBe("no_device");
    expect(mapMediaError(new Error("x"))).toBe("device_error");
  });
  it("formats the clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7999)).toBe("0:07");
    expect(formatClock(25_000)).toBe("0:25");
    expect(formatClock(65_000)).toBe("1:05");
  });
});
