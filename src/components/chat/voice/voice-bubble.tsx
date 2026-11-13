"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatClock } from "./machine";

type Props = {
  url: string;
  peaks: number[];
  durationMs: number;
  /** "bubble" sits inside a user message; "draft" is the preview before sending */
  variant?: "bubble" | "draft";
  className?: string;
};

/** Waveform + play/pause + duration. Plays the local blob only (nothing is fetched). */
export function VoicePlayer({ url, peaks, durationMs, variant = "bubble", className }: Props) {
  const t = useTranslations("Chat.voice");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1

  useEffect(() => {
    const a = new Audio(url);
    a.preload = "metadata";
    audioRef.current = a;
    const onTime = () => setProgress(durationMs > 0 ? Math.min(1, (a.currentTime * 1000) / durationMs) : 0);
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("ended", onEnd);
    a.addEventListener("pause", () => setPlaying(false));
    a.addEventListener("play", () => setPlaying(true));
    return () => {
      a.pause();
      a.removeAttribute("src");
      a.load();
      audioRef.current = null;
    };
  }, [url, durationMs]);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => setPlaying(false));
    else a.pause();
  }

  const playedBars = Math.round(progress * peaks.length);
  return (
    <div className={cn("flex items-center gap-3", className)} data-testid={variant === "draft" ? "voice-draft" : "voice-bubble"}>
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t("pause") : t("play")}
        className={cn(
          "grid size-11 shrink-0 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          variant === "bubble" ? "bg-cobalt text-(--brand-fg)" : "bg-sky text-cobalt-deep",
        )}
      >
        {playing ? <Pause className="size-5" aria-hidden /> : <Play className="size-5 rtl:-scale-x-100" aria-hidden />}
      </button>
      {/* decorative: bars are mirrored by direction so playback runs reading-order */}
      <div aria-hidden className="flex h-9 min-w-0 flex-1 items-center gap-[2px]" data-testid="voice-wave">
        {peaks.map((p, i) => (
          <i
            key={i}
            style={{ height: `${Math.round(p * 100)}%` }}
            className={cn("block w-[3px] min-w-[2px] max-w-[4px] flex-1 rounded-full", i < playedBars ? "bg-cobalt" : "bg-cobalt/35")}
          />
        ))}
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground" dir="ltr">
        {formatClock(durationMs)}
      </span>
    </div>
  );
}
