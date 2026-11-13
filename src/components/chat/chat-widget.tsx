"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useLocale, useTranslations } from "next-intl";
import { MessageCircle, Mic, SendHorizontal, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useVoiceRecorder } from "./voice/use-voice-recorder";
import { VoiceAnnouncer, VoiceErrorNote, VoicePanel } from "./voice/voice-panel";
import { VoicePlayer } from "./voice/voice-bubble";

type Props = { slug: string; tenantName: string };

/** Turns a non-2xx /api/chat response into an Error whose message is the API error code. */
const chatFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (!res.ok) {
    let code = "generic";
    try {
      const body = (await res.clone().json()) as { error?: { code?: string } };
      if (body.error?.code) code = body.error.code;
    } catch {
      /* keep generic */
    }
    throw new Error(code);
  }
  return res;
};

const KNOWN_ERRORS = [
  "rate_limited",
  "tenant_daily_limit",
  "not_configured",
  "message_too_long",
  "payload_too_large",
  "audio_unsupported",
  "audio_invalid",
  "audio_too_long",
  "audio_rate_limited",
  "audio_daily_limit",
] as const;

/** Voice notes the sender recorded in this widget: base64 for the request, wave for the bubble. Memory only. */
type VoiceEntry = { base64: string; peaks: number[]; durationMs: number };
type VoiceStore = Map<string, VoiceEntry>;

/** One transport per widget instance; it remembers the server's conversation id between messages. */
function createTransport(slug: string, locale: string, voices: VoiceStore) {
  let conversationId: string | undefined;
  return new DefaultChatTransport({
    api: "/api/chat",
    fetch: async (input, init) => {
      const res = await chatFetch(input, init);
      const id = res.headers.get("x-conversation-id");
      if (id) conversationId = id;
      return res;
    },
    // The server keeps the history: send only the newest user text.
    prepareSendMessagesRequest: ({ messages }) => {
      const last = [...messages].reverse().find((m) => m.role === "user");
      const voicePart = last?.parts.find((p) => p.type === "file" && p.mediaType === "audio/wav");
      const voice = voicePart && voicePart.type === "file" ? voices.get(voicePart.url) : undefined;
      const msg = last?.parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("")
        .trim();
      return {
        body: {
          tenantSlug: slug,
          locale,
          ...(conversationId ? { conversationId } : {}),
          message: voice
            ? { type: "audio", mediaType: "audio/wav", data: voice.base64 }
            : { type: "text", text: msg ?? "" },
        },
      };
    },
  });
}

export function ChatWidget({ slug, tenantName }: Props) {
  const t = useTranslations("Chat");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const [voices] = useState<VoiceStore>(() => new Map());
  const [transport] = useState(() => createTransport(slug, locale, voices));
  const recorder = useVoiceRecorder();
  const voiceActive = ["requesting", "recording", "processing", "preview"].includes(recorder.state.status);

  const { messages, sendMessage, status, error, clearError } = useChat({ transport });

  const busy = status === "submitted" || status === "streaming";
  const lastMsg = messages[messages.length - 1];
  const lastAssistantHasText =
    lastMsg?.role === "assistant" &&
    lastMsg.parts.some((p) => p.type === "text" && p.text.trim() !== "");
  const showTyping = status === "submitted" || (status === "streaming" && !lastAssistantHasText);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, showTyping, error]);

  const errorCode = error
    ? (KNOWN_ERRORS as readonly string[]).includes(error.message)
      ? error.message
      : "generic"
    : null;

  // Give keyboard focus back to the mic button when the recorder panel closes.
  const wasVoiceActive = useRef(false);
  useEffect(() => {
    if (wasVoiceActive.current && !voiceActive) document.getElementById("chat-mic")?.focus();
    wasVoiceActive.current = voiceActive;
  }, [voiceActive]);

  // Free the local audio of sent voice notes when the widget goes away.
  useEffect(() => {
    const map = voices;
    return () => {
      for (const url of map.keys()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, [voices]);

  async function sendVoice() {
    if (busy) return;
    const clip = await recorder.take();
    if (!clip) return;
    clearError();
    voices.set(clip.url, { base64: clip.base64, peaks: clip.peaks, durationMs: clip.durationMs });
    void sendMessage({ parts: [{ type: "file", mediaType: "audio/wav", url: clip.url }] });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    clearError();
    recorder.clearError();
    setText("");
    void sendMessage({ text: value });
  }

  return (
    <>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("open")}
          className="fixed bottom-4 end-4 z-40 flex items-center gap-2 rounded-full bg-cobalt px-5 py-3 font-heading text-sm font-medium text-(--brand-fg) shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:hidden"
        >
          <MessageCircle className="size-5" aria-hidden />
          {t("title")}
        </button>
      ) : null}

      <section
        aria-label={t("title")}
        data-testid="chat-widget"
        className={cn(
          "flex-col overflow-hidden bg-paper",
          open ? "fixed inset-0 z-50 flex" : "hidden",
          "lg:static lg:z-auto lg:flex lg:h-[34rem] lg:rounded-2xl lg:border lg:border-line lg:shadow-sm",
        )}
      >
        <header className="flex items-center gap-3 bg-cobalt px-4 py-3 text-(--brand-fg)">
          <span
            aria-hidden
            className="grid size-10 shrink-0 place-items-center rounded-[14px_14px_14px_4px] bg-saffron font-heading text-lg font-bold text-ink rtl:rounded-[14px_14px_4px_14px]"
          >
            {tenantName.trim().charAt(0)}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-heading text-base font-semibold">{t("title")}</h2>
            <p className="truncate text-xs text-(--brand-fg)/85">{t("subtitle")}</p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t("close")}
            className="rounded-full p-2 hover:bg-(--brand-fg)/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-fg) lg:hidden"
          >
            <X className="size-5" aria-hidden />
          </button>
        </header>

        <div
          ref={listRef}
          role="log"
          aria-live="polite"
          aria-label={t("messages")}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-mist p-4"
        >
          <Bubble role="assistant" label={t("assistant")}>
            {t("welcome", { name: tenantName })}
          </Bubble>
          {messages.map((m) => {
            const body = m.parts
              .map((p) => (p.type === "text" ? p.text : ""))
              .join("");
            const filePart = m.parts.find((p) => p.type === "file");
            const voice = filePart && filePart.type === "file" ? voices.get(filePart.url) : undefined;
            if (m.role === "user" && filePart && filePart.type === "file" && voice) {
              return (
                <Bubble key={m.id} role="user" label={t("you")} wide>
                  <span className="sr-only">{t("voice.noteLabel")}: </span>
                  <VoicePlayer url={filePart.url} peaks={voice.peaks} durationMs={voice.durationMs} />
                </Bubble>
              );
            }
            if (!body.trim()) return null;
            return (
              <Bubble
                key={m.id}
                role={m.role === "user" ? "user" : "assistant"}
                label={m.role === "user" ? t("you") : t("assistant")}
              >
                {body}
              </Bubble>
            );
          })}
          {showTyping ? (
            <div
              role="status"
              aria-label={t("typing")}
              className="w-fit self-start rounded-2xl rounded-ss-sm bg-paper px-4 py-3 shadow-sm"
            >
              <span className="flex gap-1.5" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <i
                    key={i}
                    style={{ animationDelay: `${i * 0.18}s` }}
                    className="size-2 animate-pulse rounded-full bg-cobalt/60 motion-reduce:animate-none"
                  />
                ))}
              </span>
            </div>
          ) : null}
          {errorCode ? (
            <div
              role="alert"
              data-testid="chat-error"
              className="flex gap-2 rounded-xl border border-destructive/40 bg-paper p-3 text-sm text-ink"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <div>
                <p className="font-medium">{t("errorTitle")}</p>
                <p>{t(`errors.${errorCode}`)}</p>
              </div>
            </div>
          ) : null}
        </div>

        <VoiceAnnouncer state={recorder.state} />
        {recorder.state.status === "error" ? <VoiceErrorNote error={recorder.state.error} /> : null}
        {voiceActive ? (
          <VoicePanel
            state={recorder.state}
            level={recorder.level}
            draft={recorder.draft}
            reducedMotion={recorder.reducedMotion}
            busy={busy}
            onStop={recorder.stop}
            onCancel={recorder.cancel}
            onSend={() => void sendVoice()}
          />
        ) : (
        <form method="post" onSubmit={submit} className="flex items-end gap-2 border-t border-line bg-paper p-3">
          <label htmlFor="chat-input" className="sr-only">
            {t("inputLabel")}
          </label>
          <input
            id="chat-input"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
            autoComplete="off"
            placeholder={t("placeholder")}
            className="min-w-0 flex-1 rounded-full border border-line bg-mist px-4 py-2 text-base text-ink placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void recorder.start()}
            aria-label={t("mic")}
            title={t("mic")}
            id="chat-mic"
            data-testid="mic-button"
            className="grid size-11 shrink-0 place-items-center rounded-full border border-line text-ink hover:bg-sky focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
          >
            <Mic className="size-5" aria-hidden />
          </button>
          <button
            type="submit"
            disabled={busy || !text.trim()}
            aria-label={t("send")}
            className="grid size-11 shrink-0 place-items-center rounded-full bg-cobalt text-(--brand-fg) disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <SendHorizontal className="size-5 rtl:-scale-x-100" aria-hidden />
          </button>
        </form>
        )}
      </section>
    </>
  );
}

function Bubble({
  role,
  label,
  children,
  wide = false,
}: {
  role: "user" | "assistant";
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const user = role === "user";
  return (
    <div
      className={cn(
        "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2 text-[0.95rem] leading-relaxed shadow-sm",
        wide && "w-[min(85%,18rem)] min-w-[12rem]",
        user
          ? "self-end rounded-se-sm bg-sky text-ink"
          : "self-start rounded-ss-sm bg-paper text-ink",
      )}
    >
      <span className="sr-only">{label}: </span>
      {children}
    </div>
  );
}
