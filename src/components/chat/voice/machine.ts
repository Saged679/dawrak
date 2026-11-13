import { VOICE } from "@/lib/audio/limits";

export const MAX_VOICE_MS = VOICE.maxSeconds * 1000;
export const MIN_VOICE_MS = VOICE.minSeconds * 1000;

export type VoiceError =
  | "denied"
  | "no_device"
  | "insecure"
  | "unsupported"
  | "device_error"
  | "too_short"
  | "encode_failed";

export type VoiceState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "recording"; elapsedMs: number }
  | { status: "processing"; reason: "stop" | "limit" }
  | { status: "preview"; durationMs: number }
  | { status: "error"; error: VoiceError };

export type VoiceEvent =
  | { type: "TAP_MIC" }
  | { type: "GRANTED" }
  | { type: "FAILED"; error: VoiceError }
  | { type: "TICK"; elapsedMs: number }
  | { type: "STOP" }
  | { type: "ENCODED"; durationMs: number }
  | { type: "CANCEL" }
  | { type: "RESET" };

export const initialVoiceState: VoiceState = { status: "idle" };

/** Pure state machine of the recorder; events that do not apply to the current state are ignored. */
export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case "TAP_MIC":
      return state.status === "idle" || state.status === "error" ? { status: "requesting" } : state;
    case "GRANTED":
      return state.status === "requesting" ? { status: "recording", elapsedMs: 0 } : state;
    case "FAILED":
      // allowed from idle too: the widget reports "unsupported" / "insecure" before asking for the mic
      return state.status === "idle" || state.status === "requesting" || state.status === "recording" || state.status === "processing" || state.status === "error"
        ? { status: "error", error: event.error }
        : state;
    case "TICK":
      if (state.status !== "recording") return state;
      return event.elapsedMs >= MAX_VOICE_MS
        ? { status: "processing", reason: "limit" }
        : { status: "recording", elapsedMs: Math.max(0, event.elapsedMs) };
    case "STOP":
      return state.status === "recording" ? { status: "processing", reason: "stop" } : state;
    case "ENCODED":
      if (state.status !== "processing") return state;
      return event.durationMs < MIN_VOICE_MS
        ? { status: "error", error: "too_short" }
        : { status: "preview", durationMs: Math.min(event.durationMs, MAX_VOICE_MS) };
    case "CANCEL":
      return state.status === "idle" ? state : { status: "idle" };
    case "RESET":
      return { status: "idle" };
  }
}

export type SupportEnv = {
  isSecureContext?: boolean;
  navigator?: { mediaDevices?: { getUserMedia?: unknown } };
  MediaRecorder?: unknown;
  AudioContext?: unknown;
  OfflineAudioContext?: unknown;
};

/** Feature detection only; the microphone is never requested here. */
export function detectVoiceSupport(env: SupportEnv): "ok" | "insecure" | "unsupported" {
  if (env.isSecureContext === false) return "insecure";
  if (
    typeof env.navigator?.mediaDevices?.getUserMedia !== "function" ||
    typeof env.MediaRecorder !== "function" ||
    typeof env.AudioContext !== "function" ||
    typeof env.OfflineAudioContext !== "function"
  ) {
    return "unsupported";
  }
  return "ok";
}

/** Maps a getUserMedia rejection to our error codes. */
export function mapMediaError(e: unknown): VoiceError {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "no_device";
  return "device_error";
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
