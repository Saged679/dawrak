"use client";

import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { addFaq, addText } from "@/app/[locale]/dashboard/knowledge/actions";
import { useRouter } from "@/i18n/navigation";
import type { KbResult } from "@/lib/dashboard/knowledge";
import { MAX_PDF_BYTES } from "@/lib/dashboard/knowledge-limits";
import { Field, inputClass, Notice, primaryBtn, textareaClass, type Msg } from "@/components/dashboard/manage/form-ui";

const card = "flex flex-col gap-4 rounded-2xl border border-line bg-paper p-4";

/** Turns a result into a status message; a saved-but-not-indexed document is a warning, not success. */
function useReport() {
  const te = useTranslations("Knowledge.errors");
  const t = useTranslations("Knowledge");
  return (res: KbResult<{ truncated?: boolean }>): Msg => {
    if (res.ok) return { kind: res.truncated ? "warn" : "ok", text: res.truncated ? t("savedTruncated") : t("saved") };
    if (res.documentId && (res.code === "embedding_failed" || res.code === "rate_limited")) {
      return { kind: "warn", text: `${te(res.code)} ${t("savedNotIndexed")}` };
    }
    return { kind: "error", text: te(res.code) };
  };
}

export function AddFaqForm() {
  const t = useTranslations("Knowledge");
  const router = useRouter();
  const report = useReport();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [q, setQ] = useState("");
  const [a, setA] = useState("");

  return (
    <form
      method="post"
      className={card}
      aria-labelledby="kb-faq-h"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        start(async () => {
          const res = await addFaq({ question: q, answer: a });
          setMsg(report(res));
          if (res.ok) {
            setQ("");
            setA("");
          }
          router.refresh();
        });
      }}
    >
      <h2 id="kb-faq-h" className="font-heading text-lg font-semibold">
        {t("faq.title")}
      </h2>
      <Field label={t("faq.question")}>
        {(p) => (
          <input {...p} dir="auto" required minLength={2} maxLength={500} value={q} onChange={(e) => setQ(e.target.value)} className={inputClass} data-testid="faq-question" />
        )}
      </Field>
      <Field label={t("faq.answer")} hint={t("faq.answerHint")}>
        {(p) => (
          <textarea {...p} dir="auto" required minLength={2} maxLength={4000} rows={4} value={a} onChange={(e) => setA(e.target.value)} className={textareaClass} data-testid="faq-answer" />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={primaryBtn} data-testid="faq-submit">
          {pending ? t("saving") : t("faq.submit")}
        </button>
        <Notice msg={msg} testId="faq-msg" />
      </div>
    </form>
  );
}

export function AddTextForm({ maxChars }: { maxChars: number }) {
  const t = useTranslations("Knowledge");
  const router = useRouter();
  const report = useReport();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  return (
    <form
      method="post"
      className={card}
      aria-labelledby="kb-text-h"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        start(async () => {
          const res = await addText({ title, content });
          setMsg(report(res));
          if (res.ok) {
            setTitle("");
            setContent("");
          }
          router.refresh();
        });
      }}
    >
      <h2 id="kb-text-h" className="font-heading text-lg font-semibold">
        {t("text.title")}
      </h2>
      <Field label={t("text.docTitle")}>
        {(p) => (
          <input {...p} dir="auto" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} data-testid="text-title" />
        )}
      </Field>
      <Field label={t("text.content")} hint={t("text.contentHint", { n: maxChars.toLocaleString("en") })}>
        {(p) => (
          <textarea {...p} dir="auto" required minLength={2} rows={6} value={content} onChange={(e) => setContent(e.target.value)} className={textareaClass} data-testid="text-content" />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={primaryBtn} data-testid="text-submit">
          {pending ? t("saving") : t("text.submit")}
        </button>
        <Notice msg={msg} testId="text-msg" />
      </div>
    </form>
  );
}

export function UploadPdfForm() {
  const t = useTranslations("Knowledge");
  const te = useTranslations("Knowledge.errors");
  const router = useRouter();
  const report = useReport();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [title, setTitle] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMsg({ kind: "error", text: te("invalid") });
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setMsg({ kind: "error", text: te("too_large") });
      return;
    }
    setMsg(null);
    setPending(true);
    try {
      const body = new FormData();
      body.set("file", file);
      if (title.trim()) body.set("title", title.trim());
      const res = await fetch("/api/dashboard/knowledge/pdf", { method: "POST", body });
      const json = (await res.json()) as KbResult<{ truncated?: boolean }>;
      setMsg(report(json));
      if (json.ok) {
        setTitle("");
        if (fileRef.current) fileRef.current.value = "";
      }
      router.refresh();
    } catch {
      setMsg({ kind: "error", text: te("generic") });
    } finally {
      setPending(false);
    }
  }

  return (
    <form method="post" encType="multipart/form-data" className={card} aria-labelledby="kb-pdf-h" onSubmit={submit}>
      <h2 id="kb-pdf-h" className="font-heading text-lg font-semibold">
        {t("pdf.title")}
      </h2>
      <Field label={t("pdf.file")} hint={t("pdf.hint")}>
        {(p) => (
          <input
            {...p}
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            required
            className="min-h-11 w-full rounded-lg border border-line bg-paper p-2 text-sm outline-none file:me-3 file:rounded-full file:border-0 file:bg-sky file:px-4 file:py-2 file:text-sm file:font-medium file:text-cobalt-deep focus-visible:ring-3 focus-visible:ring-ring/40"
            data-testid="pdf-file"
          />
        )}
      </Field>
      <Field label={t("pdf.docTitle")}>
        {(p) => (
          <input {...p} dir="auto" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} data-testid="pdf-title" />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={primaryBtn} data-testid="pdf-submit">
          {pending ? t("pdf.uploading") : t("pdf.submit")}
        </button>
        <Notice msg={msg} testId="pdf-msg" />
      </div>
    </form>
  );
}
