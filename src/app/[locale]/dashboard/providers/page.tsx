import { DemoLockedBanner } from "@/components/dashboard/manage/demo-locked";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import type { Loc } from "@/components/booking/dates";
import { ActiveToggle } from "@/components/dashboard/manage/active-toggle";
import { primaryBtn, quietBtn } from "@/components/dashboard/manage/form-classes";
import { Link, redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { canManageCatalog } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import { listManagedProviders } from "@/lib/dashboard/catalog";
import { setProviderActive } from "./actions";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Providers" });
  return { title: t("metaTitle") };
}

export default async function ProvidersPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const loc = locale as Loc;
  const session = await requireSession(locale);
  // A provider has no list: straight to their own schedule (or home if no provider row is linked).
  if (session.role === "provider") {
    redirect({
      href: session.providerId ? `/dashboard/providers/${session.providerId}` : "/dashboard",
      locale,
    });
  }
  const canEdit = canManageCatalog(session.role);
  const [t, tm, providers] = await Promise.all([
    getTranslations("Providers"),
    getTranslations("Manage"),
    listManagedProviders(session),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{t("title")}</h1>
          <p className="text-muted-foreground">{canEdit ? t("lead") : t("leadReadOnly")}</p>
        </div>
        {canEdit && session.tenant.is_demo ? (
          <span aria-disabled="true" title={tm("errors.demo_readonly")} className={`${primaryBtn} cursor-not-allowed opacity-50`} data-testid="provider-new">
            <Plus className="size-4" aria-hidden />
            {t("new")}
          </span>
        ) : canEdit ? (
          <Link href="/dashboard/providers/new" className={primaryBtn} data-testid="provider-new">
            <Plus className="size-4" aria-hidden />
            {t("new")}
          </Link>
        ) : null}
      </header>

      {providers.some((p) => p.locked) ? <DemoLockedBanner /> : null}

      {providers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-4 text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="provider-list">
          {providers.map((p) => (
            <li
              key={p.id}
              data-testid={`provider-${p.id}`}
              data-active={p.is_active}
              className="flex flex-col gap-3 rounded-2xl border border-line bg-paper p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-heading text-lg font-semibold">{loc === "en" ? p.name_en : p.name_ar}</span>
                  {p.is_active ? null : (
                    <span className="rounded-full border border-dashed border-line px-2 py-0.5 text-xs text-muted-foreground">
                      {t("inactive")}
                    </span>
                  )}
                </p>
                {(loc === "en" ? p.title_en || p.title_ar : p.title_ar) ? (
                  <p className="text-sm text-muted-foreground">{loc === "en" ? p.title_en || p.title_ar : p.title_ar}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-start gap-2">
                <Link href={`/dashboard/providers/${p.id}`} className={quietBtn} data-testid={`provider-open-${p.id}`}>
                  <Pencil className="size-4" aria-hidden />
                  {canEdit ? tm("edit") : tm("view")}
                </Link>
                {canEdit ? <ActiveToggle id={p.id} active={p.is_active} action={setProviderActive} disabled={p.locked} /> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
