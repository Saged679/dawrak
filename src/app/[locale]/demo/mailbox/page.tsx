import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Info, Inbox, RefreshCw } from "lucide-react";
import { NOINDEX } from "@/lib/seo/metadata";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { readDemoSessionHash } from "@/lib/demo/session";
import { listMailbox, splitLinks } from "@/lib/demo/mailbox";
import { MailboxWatcher } from "@/components/demo/mailbox-watcher";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Mailbox" });
  // the mails hold personal links: not indexed, no referrer
  return { title: t("metaTitle"), ...NOINDEX, referrer: "no-referrer" };
}

export default async function MailboxPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations("Mailbox");

  // Only the visitor's own session (httpOnly cookie, matched by hash). No cookie: empty, never anyone else's mail.
  const hash = await readDemoSessionHash();
  const rows = hash ? await listMailbox(hash) : [];
  const fmt = new Intl.DateTimeFormat(locale === "ar" ? "ar-SA-u-nu-arab" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-3xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-3">
        <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{t("title")}</h1>
        <p className="text-muted-foreground">{t("lead")}</p>
        <p
          role="note"
          data-testid="mailbox-notice"
          className="flex w-fit max-w-full items-start gap-2 rounded-xl bg-saffron-soft px-4 py-3 text-[#6b3f00]"
        >
          <Info className="mt-1 size-4 shrink-0" aria-hidden />
          <span>{t("notice")}</span>
        </p>
      </header>

      {/* the mail is queued after the booking response: an empty mailbox is watched for a short while */}
      <MailboxWatcher
        key={rows.length}
        initialCount={rows.length}
        active={!!hash && rows.length === 0}
        labels={{ waiting: t("waiting"), none: t("noneYet"), found: t("found") }}
      />

      {rows.length === 0 ? (
        <div
          data-testid="mailbox-empty"
          className="flex flex-col items-start gap-2 rounded-2xl border border-line bg-paper p-6"
        >
          <Inbox className="size-6 text-cobalt-deep" aria-hidden />
          <p className="font-medium text-ink">{t("emptyTitle")}</p>
          <p className="text-sm text-muted-foreground">{t("emptyBody")}</p>
        </div>
      ) : (
        <ol className="flex flex-col gap-4" data-testid="mailbox-list">
          {rows.map((m) => (
            <li key={m.id}>
              <article
                data-testid="mailbox-message"
                className="min-w-0 rounded-2xl border border-line bg-paper p-4 shadow-sm"
              >
                <h2 className="break-words font-heading text-base font-semibold text-ink">{m.subject}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("to")} <bdi dir="ltr">{m.to}</bdi> - {fmt.format(new Date(m.createdAt))}
                </p>
                {/* plain text only: React escapes everything, nothing is ever injected as HTML */}
                <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm text-ink" dir="auto">
                  {splitLinks(m.body).map((part, i) =>
                    part.href ? (
                      <a
                        key={i}
                        href={part.href}
                        rel="noreferrer"
                        className="break-all rounded-sm text-cobalt underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {part.text}
                      </a>
                    ) : (
                      <span key={i}>{part.text}</span>
                    ),
                  )}
                </pre>
              </article>
            </li>
          ))}
        </ol>
      )}

      <p className="flex flex-wrap items-center gap-x-4">
        {/* no-JS fallback: a plain link back to this page (a GET, nothing is changed) */}
        <Link
          href="/demo/mailbox"
          data-testid="mailbox-refresh"
          className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-cobalt underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <RefreshCw className="size-4" aria-hidden />
          {t("refresh")}
        </Link>
        <Link
          href="/demo"
          className="inline-flex min-h-11 items-center rounded-md px-2 text-cobalt underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t("backToDemo")}
        </Link>
      </p>
    </main>
  );
}
