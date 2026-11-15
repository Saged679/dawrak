import { DemoLockedBanner } from "@/components/dashboard/manage/demo-locked";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import { formatMoney, formatNumber, type Loc } from "@/components/booking/dates";
import { ActiveToggle } from "@/components/dashboard/manage/active-toggle";
import { primaryBtn, quietBtn } from "@/components/dashboard/manage/form-classes";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { canManageCatalog } from "@/lib/auth/roles";
import { requireRole } from "@/lib/auth/session";
import { listManagedProviders, listServices } from "@/lib/dashboard/catalog";
import { setServiceActive } from "./actions";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Services" });
  return { title: t("metaTitle") };
}

export default async function ServicesPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const loc = locale as Loc;
  // Server-side gate. Providers are sent back to the overview; the nav link is only a convenience.
  const session = await requireRole(locale, ["owner", "receptionist"]);
  const canEdit = canManageCatalog(session.role);
  const [t, tm, services, providers] = await Promise.all([
    getTranslations("Services"),
    getTranslations("Manage"),
    listServices(session),
    listManagedProviders(session),
  ]);
  const pick = (n: { name_ar: string; name_en: string | null }) =>
    loc === "en" ? n.name_en || n.name_ar : n.name_ar;
  const providerName = new Map(providers.map((p) => [p.id, pick(p)]));
  const cur = session.tenant.currency;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{t("title")}</h1>
          <p className="text-muted-foreground">{canEdit ? t("lead") : t("leadReadOnly")}</p>
        </div>
        {canEdit && session.tenant.is_demo ? (
          <span aria-disabled="true" title={tm("errors.demo_readonly")} className={`${primaryBtn} cursor-not-allowed opacity-50`} data-testid="service-new">
            <Plus className="size-4" aria-hidden />
            {t("new")}
          </span>
        ) : canEdit ? (
          <Link href="/dashboard/services/new" className={primaryBtn} data-testid="service-new">
            <Plus className="size-4" aria-hidden />
            {t("new")}
          </Link>
        ) : null}
      </header>

      {services.some((s) => s.locked) ? <DemoLockedBanner /> : null}

      {services.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-4 text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="service-list">
          {services.map((s) => {
            const names = s.providerIds.map((id) => providerName.get(id)).filter(Boolean) as string[];
            return (
              <li
                key={s.id}
                data-testid={`service-${s.id}`}
                data-active={s.is_active}
                className="flex flex-col gap-3 rounded-2xl border border-line bg-paper p-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-heading text-lg font-semibold">{pick(s)}</span>
                    {s.is_active ? null : (
                      <span className="rounded-full border border-dashed border-line px-2 py-0.5 text-xs text-muted-foreground">
                        {t("inactive")}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t("durationValue", { n: formatNumber(s.duration_min, loc) })}
                    {s.buffer_min > 0 ? ` · ${t("bufferValue", { n: formatNumber(s.buffer_min, loc) })}` : ""}
                    {" · "}
                    {formatMoney(s.price, cur, loc)}
                  </p>
                  <p className="text-sm">
                    <span className="text-muted-foreground">{t("fields.providers")}: </span>
                    {names.length > 0 ? names.join(loc === "ar" ? "، " : ", ") : t("noneLinked")}
                  </p>
                </div>
                {canEdit ? (
                  <div className="flex shrink-0 flex-wrap items-start gap-2">
                    <Link href={`/dashboard/services/${s.id}`} className={quietBtn} data-testid={`service-edit-${s.id}`}>
                      <Pencil className="size-4" aria-hidden />
                      {tm("edit")}
                    </Link>
                    <ActiveToggle id={s.id} active={s.is_active} action={setServiceActive} disabled={s.locked} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
