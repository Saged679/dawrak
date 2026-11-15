import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Bot, ChevronLeft, ChevronRight, Globe, Mic } from "lucide-react";
import { formatGregorian, dateKeyInZone, formatTime, type Loc } from "@/components/booking/dates";
import { quietBtn } from "@/components/dashboard/manage/form-classes";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { requireRole } from "@/lib/auth/session";
import { listConversations } from "@/lib/dashboard/conversations";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Conversations" });
  return { title: t("metaTitle") };
}

export default async function ConversationsPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const loc = locale as Loc;
  // Server-side gate: owner and receptionist only. A provider is sent back to the overview.
  const session = await requireRole(locale, ["owner", "receptionist"]);
  const sp = await searchParams;
  const raw = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const page = Math.min(500, Math.max(1, Number.parseInt(raw ?? "1", 10) || 1));

  const [t, { items, hasMore }] = await Promise.all([
    getTranslations("Conversations"),
    listConversations(session, page),
  ]);
  const tz = session.tenant.timezone;
  const when = (iso: string) =>
    `${formatGregorian(dateKeyInZone(iso, tz), loc, { day: "numeric", month: "short" })} ${formatTime(iso, tz, loc)}`;
  const Prev = loc === "ar" ? ChevronRight : ChevronLeft;
  const Next = loc === "ar" ? ChevronLeft : ChevronRight;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{t("title")}</h1>
        <p className="text-muted-foreground">{t("lead")}</p>
      </header>

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-4 text-muted-foreground" data-testid="conv-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="conv-list">
          {items.map((c) => (
            <li key={c.id}>
              <Link
                href={`/dashboard/conversations/${c.id}`}
                data-testid={`conv-${c.id}`}
                className="flex flex-col gap-2 rounded-2xl border border-line bg-paper p-4 outline-none hover:bg-sky focus-visible:ring-3 focus-visible:ring-ring/60"
              >
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-heading text-base font-semibold" dir="auto" data-testid="conv-customer">
                    {c.customer?.full_name ?? t("anonymous")}
                  </span>
                  <span className="text-xs text-muted-foreground">{when(c.lastMessageAt)}</span>
                </span>
                <span className="flex items-start gap-2 text-sm text-muted-foreground">
                  {c.last?.role === "assistant" ? <Bot className="mt-0.5 size-4 shrink-0" aria-hidden /> : null}
                  {c.last?.voice ? (
                    <span className="flex items-center gap-1.5" data-testid="voice-marker">
                      <Mic className="size-4 shrink-0" aria-hidden />
                      {c.last.voice.seconds != null ? t("voiceNoteDuration", { seconds: c.last.voice.seconds }) : t("voiceNote")}
                    </span>
                  ) : (
                    <span className="line-clamp-2 break-words" dir="auto">
                      {c.last?.content ?? t("noMessages")}
                    </span>
                  )}
                </span>
                <span className="inline-flex w-fit items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-muted-foreground">
                  <Globe className="size-3" aria-hidden />
                  {t(`channel.${c.channel === "whatsapp" ? "whatsapp" : "web"}`)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {page > 1 || hasMore ? (
        <nav aria-label={t("pagination")} className="flex items-center justify-between gap-2">
          {page > 1 ? (
            <Link href={page === 2 ? "/dashboard/conversations" : `/dashboard/conversations?page=${page - 1}`} className={quietBtn}>
              <Prev className="size-4" aria-hidden />
              {t("prev")}
            </Link>
          ) : (
            <span />
          )}
          {hasMore ? (
            <Link href={`/dashboard/conversations?page=${page + 1}`} className={quietBtn}>
              {t("next")}
              <Next className="size-4" aria-hidden />
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
