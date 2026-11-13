import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { CalendarCheck, Mic } from "lucide-react";
import { dateKeyInZone, formatGregorian, formatTime, type Loc } from "@/components/booking/dates";
import { BackLink } from "@/components/dashboard/manage/back-link";
import { quietBtn } from "@/components/dashboard/manage/form-ui";
import { StatusBadge } from "@/components/dashboard/status";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { requireRole } from "@/lib/auth/session";
import { getThread } from "@/lib/dashboard/conversations";
import { cn } from "@/lib/utils";

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Conversations" });
  return { title: t("threadMetaTitle") };
}

export default async function ConversationThreadPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale) || !z.uuid().safeParse(id).success) notFound();
  setRequestLocale(locale);
  const loc = locale as Loc;
  const session = await requireRole(locale, ["owner", "receptionist"]);
  const sp = await searchParams;
  const raw = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const page = Math.min(500, Math.max(1, Number.parseInt(raw ?? "1", 10) || 1));

  const thread = await getThread(session, id, page);
  if (!thread) notFound();
  const [t, ts] = await Promise.all([getTranslations("Conversations"), getTranslations("Dash.status")]);
  const tz = session.tenant.timezone;
  const stamp = (iso: string) =>
    `${formatGregorian(dateKeyInZone(iso, tz), loc, { day: "numeric", month: "short" })} ${formatTime(iso, tz, loc)}`;
  const pick = (n: { name_ar: string; name_en: string | null }) => (loc === "en" ? n.name_en || n.name_ar : n.name_ar);
  const { conversation: c, messages, appointments, hasMore } = thread;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <BackLink href="/dashboard/conversations" label={t("back")} />
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold sm:text-3xl" dir="auto" data-testid="thread-customer">
          {c.customer?.full_name ?? t("anonymous")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(`channel.${c.channel === "whatsapp" ? "whatsapp" : "web"}`)} · {t("started", { date: stamp(c.startedAt) })}
        </p>
        <p className="text-xs text-muted-foreground">{t("readOnly")}</p>
      </header>

      {appointments.length > 0 ? (
        <section aria-labelledby="conv-appts-h" className="flex flex-col gap-2 rounded-2xl border border-line bg-paper p-4" data-testid="thread-appointments">
          <h2 id="conv-appts-h" className="font-heading text-base font-semibold">
            {t("bookings.title")}
          </h2>
          <ul className="flex flex-col gap-2">
            {appointments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <CalendarCheck className="size-4 shrink-0 text-cobalt-deep" aria-hidden />
                  <span dir="auto">
                    {pick(a.service)} · {pick(a.provider)} · {stamp(a.startsAt)}
                  </span>
                  <StatusBadge status={a.status} label={ts(a.status)} />
                </span>
                <Link
                  href={`/dashboard/calendar?date=${dateKeyInZone(a.startsAt, tz)}`}
                  className={quietBtn}
                  data-testid={`thread-appt-${a.id}`}
                >
                  {t("bookings.open")}
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("bookings.note")}</p>
        </section>
      ) : null}

      <ol className="flex flex-col gap-3" data-testid="thread-messages" aria-label={t("messagesLabel")}>
        {messages.map((m) => {
          const mine = m.role === "user";
          const internal = m.role === "tool" || m.role === "system";
          return (
            <li key={m.id} data-role={m.role} className={cn("flex flex-col gap-1", mine ? "items-start" : "items-end")}>
              <span className="text-xs text-muted-foreground">
                {t(`role.${m.role}`)} · {stamp(m.createdAt)}
              </span>
              {/* untrusted text: plain text only, wrapped, never HTML */}
              <p
                dir="auto"
                className={cn(
                  "max-w-[88%] whitespace-pre-wrap break-words rounded-2xl border px-4 py-2 text-base leading-relaxed",
                  mine && "rounded-ss-sm border-line bg-paper text-ink",
                  m.role === "assistant" && "rounded-se-sm border-cobalt bg-sky text-cobalt-deep",
                  internal && "border-dashed border-line bg-mist text-sm text-muted-foreground",
                )}
              >
                {m.voice ? (
                  <span className="inline-flex items-center gap-1.5" data-testid="voice-marker">
                    <Mic className="size-4 shrink-0" aria-hidden />
                    {m.voice.seconds != null ? t("voiceNoteDuration", { seconds: m.voice.seconds }) : t("voiceNote")}
                  </span>
                ) : (
                  m.content
                )}
              </p>
            </li>
          );
        })}
      </ol>

      {page > 1 || hasMore ? (
        <nav aria-label={t("pagination")} className="flex items-center justify-between gap-2">
          {page > 1 ? (
            <Link href={`/dashboard/conversations/${id}${page === 2 ? "" : `?page=${page - 1}`}`} className={quietBtn}>
              {t("earlier")}
            </Link>
          ) : (
            <span />
          )}
          {hasMore ? (
            <Link href={`/dashboard/conversations/${id}?page=${page + 1}`} className={quietBtn}>
              {t("later")}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
