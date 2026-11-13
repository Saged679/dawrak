"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, SendHorizontal, Square, Trash2, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MAX_VOICE_MS, formatClock, type VoiceError, type VoiceState } from "./machine";
import type { VoiceDraft } from "./use-voice-recorder";
import { VoicePlayer } from "./voice-bubble";

type Props = {
  state: VoiceState;
  level: number;
  draft: VoiceDraft | null;
  reducedMotion: boolean;
  busy: boolean;
  onStop: () => void;
  onCancel: () => void;
  onSend: () => void;
};

const btn =
  "grid size-11 shrink-0 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Screen reader announcements for the recording state (a polite live region that is always mounted). */
export function VoiceAnnouncer({ state }: { state: VoiceState }) {
  const t = useTranslations("Chat.voice");
  // derive-during-render (no effect): remember the previous status and the message of the last transition
  const [prev, setPrev] = useState<VoiceState["status"]>("idle");
  const [base, setBase] = useState("");
  if (prev !== state.status) {
    setPrev(state.status);
    if (state.status === "recording") setBase(t("announce.recording", { seconds: MAX_VOICE_MS / 1000 }));
    else if (state.status === "preview") setBase(t("announce.ready", { seconds: Math.round(state.durationMs / 1000) }));
    else if (state.status === "idle") setBase(prev === "preview" ? "" : t("announce.cancelled"));
    else if (state.status === "error") setBase("");
  }
  const text = state.status === "recording" && state.elapsedMs >= MAX_VOICE_MS - 5000 ? t("announce.fiveLeft") : base;

  return (
    <div role="status" aria-live="polite" className="sr-only" data-testid="voice-live">
      {text}
    </div>
  );
}

export function VoiceErrorNote({ error }: { error: VoiceError }) {
  const t = useTranslations("Chat.voice");
  return (
    <div
      role="alert"
      data-testid="voice-error"
      className="mx-3 mb-0 mt-2 flex gap-2 rounded-xl border border-destructive/40 bg-paper p-3 text-sm text-ink"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <p>{t(`errors.${error}`)}</p>
    </div>
  );
}

export function VoicePanel({ state, level, draft, reducedMotion, busy, onStop, onCancel, onSend }: Props) {
  const t = useTranslations("Chat.voice");
  const ref = useRef<HTMLDivElement | null>(null);

  // move focus to the first control when the panel changes step, so keyboard users are not lost
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [state.status]);

  return (
    <div
      ref={ref}
      data-testid="voice-panel"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="flex items-center gap-2 border-t border-line bg-paper p-3"
    >
      {state.status === "requesting" ? (
        <>
          <p className="min-w-0 flex-1 px-2 text-sm text-muted-foreground">{t("allowPrompt")}</p>
          <button type="button" onClick={onCancel} aria-label={t("cancel")} data-autofocus className={cn(btn, "border border-line text-ink")}>
            <X className="size-5" aria-hidden />
          </button>
        </>
      ) : null}

      {state.status === "recording" ? (
        <>
          <button type="button" onClick={onCancel} aria-label={t("cancel")} className={cn(btn, "border border-line text-ink")}>
            <X className="size-5" aria-hidden />
          </button>
          <span aria-hidden className={cn("size-3 shrink-0 rounded-full bg-destructive", !reducedMotion && "animate-pulse")} />
          <span className="shrink-0 text-sm font-medium tabular-nums" dir="ltr" data-testid="voice-timer">
            <span aria-hidden>
              {formatClock(state.elapsedMs)} / {formatClock(MAX_VOICE_MS)}
            </span>
            <span className="sr-only">{t("timer", { seconds: Math.floor(state.elapsedMs / 1000), max: MAX_VOICE_MS / 1000 })}</span>
          </span>
          <div aria-hidden className="flex h-8 min-w-0 flex-1 items-center justify-center gap-[3px]" data-testid="voice-meter">
            {reducedMotion
              ? null
              : [0.5, 0.8, 1, 0.8, 0.5].map((k, i) => (
                  <i
                    key={i}
                    style={{ height: `${Math.round(12 + Math.min(1, level * k * 1.4) * 88)}%` }}
                    className="block w-1 rounded-full bg-cobalt"
                  />
                ))}
          </div>
          <button type="button" onClick={onStop} aria-label={t("stop")} data-autofocus className={cn(btn, "bg-cobalt text-(--brand-fg)")}>
            <Square className="size-4 fill-current" aria-hidden />
          </button>
        </>
      ) : null}

      {state.status === "processing" ? (
        <p className="flex flex-1 items-center gap-2 px-2 text-sm text-muted-foreground">
          <Loader2 className={cn("size-4", !reducedMotion && "animate-spin")} aria-hidden />
          {state.reason === "limit" ? t("limitReached", { seconds: MAX_VOICE_MS / 1000 }) : t("preparing")}
        </p>
      ) : null}

      {state.status === "preview" && draft ? (
        <>
          <button type="button" onClick={onCancel} aria-label={t("discard")} data-testid="voice-discard" className={cn(btn, "border border-line text-ink")}>
            <Trash2 className="size-5" aria-hidden />
          </button>
          <VoicePlayer url={draft.url} peaks={draft.peaks} durationMs={draft.durationMs} variant="draft" className="min-w-0 flex-1" />
          <button
            type="button"
            onClick={onSend}
            disabled={busy}
            aria-label={t("sendVoice")}
            data-testid="voice-send"
            data-autofocus
            className={cn(btn, "bg-cobalt text-(--brand-fg) disabled:opacity-50")}
          >
            <SendHorizontal className="size-5 rtl:-scale-x-100" aria-hidden />
          </button>
        </>
      ) : null}
    </div>
  );
}
