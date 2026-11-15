import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { AlertTriangle, CircleCheck, FileText, HelpCircle, ScrollText } from "lucide-react";
import { dateKeyInZone, formatGregorian, formatNumber, type Loc } from "@/components/booking/dates";
import { AddFaqForm, AddTextForm, UploadPdfForm } from "@/components/dashboard/knowledge/add-forms";
import { DocActions } from "@/components/dashboard/knowledge/doc-actions";
import { DemoLockedBanner } from "@/components/dashboard/manage/demo-locked";
import { quietBtn } from "@/components/dashboard/manage/form-classes";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { MAX_DOC_CHARS } from "@/lib/agent/knowledge";
import { canManageKnowledge } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { isLockedInDemo } from "@/lib/dashboard/demo-lock";
import { listDocuments } from "@/lib/dashboard/knowledge";
import { cn } from "@/lib/utils";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Knowledge" });
  return { title: t("metaTitle") };
}

const SOURCE_ICON = { faq: HelpCircle, text: ScrollText, pdf: FileText } as const;

export default async function KnowledgePage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const loc = locale as Loc;
  // Server-side gate: only the owner. Everyone else goes back to the overview.
  const session = await requireRole(locale, ["owner"]);
  if (!canManageKnowledge(session.role)) notFound();
  const sp = await searchParams;
  const raw = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const page = Math.min(500, Math.max(1, Number.parseInt(raw ?? "1", 10) || 1));

  const [t, db] = await Promise.all([getTranslations("Knowledge"), createSupabaseServerClient()]);
  const { items, hasMore } = await listDocuments(db, session.tenant.id, page);
  const tz = session.tenant.timezone;
  const day = (iso: string) =>
    formatGregorian(dateKeyInZone(iso, tz), loc, { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{t("title")}</h1>
        <p className="text-muted-foreground">{t("lead")}</p>
        {session.tenant.is_demo ? <p className="text-sm text-muted-foreground">{t("demoNote")}</p> : null}
      </header>
      {items.some((d) => isLockedInDemo(session, d.createdBy)) ? <DemoLockedBanner /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <AddFaqForm />
        <AddTextForm maxChars={MAX_DOC_CHARS} />
        <div className="lg:col-span-2">
          <UploadPdfForm />
        </div>
      </div>

      <section aria-labelledby="kb-docs-h" className="flex flex-col gap-3">
        <h2 id="kb-docs-h" className="font-heading text-lg font-semibold">
          {t("docs.title")}
        </h2>
        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-4 text-muted-foreground" data-testid="kb-empty">
            {t("docs.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="kb-list">
            {items.map((d) => {
              const Icon = SOURCE_ICON[d.sourceType] ?? FileText;
              const failed = d.status === "failed";
              return (
                <li
                  key={d.id}
                  data-testid={`kb-doc-${d.id}`}
                  data-status={d.status}
                  className="flex flex-col gap-3 rounded-2xl border border-line bg-paper p-4 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="flex min-w-0 items-start gap-2">
                      <Icon className="mt-1 size-4 shrink-0 text-cobalt-deep" aria-hidden />
                      {/* untrusted text: rendered as plain text by React, never as HTML */}
                      <span dir="auto" className="break-words font-heading text-base font-semibold" data-testid="kb-doc-title">
                        {d.title}
                      </span>
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                      <span
                        data-testid="kb-status"
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
                          failed
                            ? "border-dashed border-[#b8741a] bg-saffron-soft text-[#6b3f00]"
                            : "border-[#1d7a5f] bg-[#dff3ec] text-[#0f4d3b]",
                        )}
                      >
                        {failed ? <AlertTriangle className="size-3" aria-hidden /> : <CircleCheck className="size-3" aria-hidden />}
                        {t(failed ? "status.failed" : "status.ready")}
                      </span>
                      <span>{t(`source.${d.sourceType}`)}</span>
                      <span aria-hidden>·</span>
                      <span>{t("docs.chunks", { n: formatNumber(d.chunkCount, loc) })}</span>
                      <span aria-hidden>·</span>
                      <span>{day(d.createdAt)}</span>
                    </p>
                    {failed ? <p className="text-sm text-[#6b3f00]">{t("docs.failedHint")}</p> : null}
                  </div>
                  <DocActions id={d.id} failed={failed} locked={isLockedInDemo(session, d.createdBy)} />
                </li>
              );
            })}
          </ul>
        )}

        {page > 1 || hasMore ? (
          <nav aria-label={t("docs.pagination")} className="flex items-center justify-between gap-2">
            {page > 1 ? (
              <Link href={page === 2 ? "/dashboard/knowledge" : `/dashboard/knowledge?page=${page - 1}`} className={quietBtn}>
                {t("docs.prev")}
              </Link>
            ) : (
              <span />
            )}
            {hasMore ? (
              <Link href={`/dashboard/knowledge?page=${page + 1}`} className={quietBtn}>
                {t("docs.next")}
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </div>
  );
}
