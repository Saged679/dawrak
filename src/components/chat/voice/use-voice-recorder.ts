"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { blobToBase64, blobToWavClip, type VoiceClip } from "./convert";
import {
  MAX_VOICE_MS,
  detectVoiceSupport,
  initialVoiceState,
  mapMediaError,
  voiceReducer,
  type VoiceState,
} from "./machine";

export type VoiceDraft = { url: string; peaks: number[]; durationMs: number };
export type SentVoice = VoiceDraft & { base64: string };

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

type WebkitWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
  webkitOfflineAudioContext?: typeof OfflineAudioContext;
};

/**
 * Microphone recorder. The mic is requested only inside start() (a user tap), the stream and
 * AudioContext are released on stop/cancel/unmount, and the audio lives only in memory until the
 * single chat request.
 */
export function useVoiceRecorder() {
  const [state, dispatch] = useReducer(voiceReducer, initialVoiceState);
  const [level, setLevel] = useState(0);
  const [draft, setDraft] = useState<VoiceDraft | null>(null);
  const clipRef = useRef<VoiceClip | null>(null);

  const stateRef = useRef<VoiceState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const token = useRef(0); // bumps on every start/cancel: stale async results are dropped
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const urlRef = useRef<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  const releaseCapture = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setLevel(0);
  }, []);

  const dropDraft = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    clipRef.current = null;
    setDraft(null);
  }, []);

  const detachRecorder = useCallback(() => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec) return;
    rec.ondataavailable = null;
    rec.onstop = null;
    rec.onerror = null;
    if (rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
  }, []);

  const cancel = useCallback(() => {
    token.current++;
    detachRecorder();
    releaseCapture();
    dropDraft();
    dispatch({ type: "CANCEL" });
  }, [detachRecorder, releaseCapture, dropDraft]);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") {
      dispatch({ type: "STOP" });
      rec.stop();
    }
  }, []);

  const start = useCallback(async () => {
    const s = stateRef.current.status;
    if (s !== "idle" && s !== "error") return;
    const w = window as WebkitWindow;
    const support = detectVoiceSupport({
      isSecureContext: window.isSecureContext,
      navigator,
      MediaRecorder: window.MediaRecorder,
      AudioContext: window.AudioContext ?? w.webkitAudioContext,
      OfflineAudioContext: window.OfflineAudioContext ?? w.webkitOfflineAudioContext,
    });
    if (support !== "ok") {
      dispatch({ type: "FAILED", error: support });
      return;
    }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    setReducedMotion(reduce);
    dropDraft();
    dispatch({ type: "TAP_MIC" });
    stateRef.current = { status: "requesting" };
    const my = ++token.current;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      if (token.current === my) dispatch({ type: "FAILED", error: mapMediaError(e) });
      return;
    }
    if (token.current !== my) {
      stream.getTracks().forEach((t) => t.stop()); // cancelled while the permission prompt was open
      return;
    }
    streamRef.current = stream;

    let rec: MediaRecorder;
    try {
      const mimeType = pickMime();
      rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      releaseCapture();
      dispatch({ type: "FAILED", error: "unsupported" });
      return;
    }
    recorderRef.current = rec;
    const chunks: Blob[] = [];
    rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };
    rec.onerror = () => {
      if (token.current !== my) return;
      token.current++;
      releaseCapture();
      dispatch({ type: "FAILED", error: "device_error" });
    };
    rec.onstop = async () => {
      if (token.current !== my) return;
      releaseCapture();
      try {
        const clip = await blobToWavClip(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
        if (token.current !== my) return;
        clipRef.current = clip;
        const url = URL.createObjectURL(clip.wav);
        urlRef.current = url;
        setDraft({ url, peaks: clip.peaks, durationMs: clip.durationMs });
        dispatch({ type: "ENCODED", durationMs: clip.durationMs });
      } catch {
        if (token.current === my) dispatch({ type: "FAILED", error: "encode_failed" });
      }
    };

    // Level meter (skipped under prefers-reduced-motion: nothing animates then, only the timer text).
    let analyser: AnalyserNode | null = null;
    if (!reduce) {
      try {
        const Ctx = window.AudioContext ?? w.webkitAudioContext!;
        const ctx = new Ctx();
        ctxRef.current = ctx;
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(analyser);
      } catch {
        analyser = null;
      }
    }
    const buf = new Uint8Array(128);
    const t0 = performance.now();
    rec.start(250);
    dispatch({ type: "GRANTED" });
    timerRef.current = setInterval(() => {
      const elapsed = performance.now() - t0;
      if (elapsed >= MAX_VOICE_MS) {
        // hard stop at the limit
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        dispatch({ type: "TICK", elapsedMs: MAX_VOICE_MS });
        if (rec.state === "recording") rec.stop();
        return;
      }
      dispatch({ type: "TICK", elapsedMs: elapsed });
      if (analyser) {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(1, peak / 64));
      }
    }, 100);
  }, [dropDraft, releaseCapture]);

  /** Hands the clip to the caller (who now owns the object URL). */
  const take = useCallback(async (): Promise<SentVoice | null> => {
    const clip = clipRef.current;
    const url = urlRef.current;
    if (!clip || !url || stateRef.current.status !== "preview") return null;
    const base64 = await blobToBase64(clip.wav);
    urlRef.current = null; // ownership moves to the message bubble
    clipRef.current = null;
    setDraft(null);
    dispatch({ type: "RESET" });
    return { url, peaks: clip.peaks, durationMs: clip.durationMs, base64 };
  }, []);

  const clearError = useCallback(() => dispatch({ type: "RESET" }), []);

  useEffect(
    () => () => {
      token.current++;
      detachRecorder();
      releaseCapture();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [detachRecorder, releaseCapture],
  );

  return { state, level, draft, start, stop, cancel, take, clearError, reducedMotion };
}
