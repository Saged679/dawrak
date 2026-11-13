import { DemoLockedBanner } from "@/components/dashboard/manage/demo-locked";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { Loc } from "@/components/booking/dates";
import { BackLink } from "@/components/dashboard/manage/back-link";
import { HoursEditor } from "@/components/dashboard/manage/hours-editor";
import { ProviderForm } from "@/components/dashboard/manage/provider-form";
import { TimeOffPanel } from "@/components/dashboard/manage/time-off-panel";
import { Link, redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { canManageCatalog } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/session";
import {
  getManagedProvider,
  listProviderHours,
  listProviderServices,
  listProviderTimeOff,
} from "@/lib/dashboard/catalog";

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Providers" });
  return { title: t("editMetaTitle") };
}

export default async function ProviderPage({ params }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale) || !z.uuid().safeParse(id).success) notFound();
  setRequestLocale(locale);
  const loc = locale as Loc;
  const session = await requireSession(locale);
  // A provider may only open their own page; anything else goes back to it (or home).
  if (session.role === "provider" && id !== session.providerId) {
    redirect({
      href: session.providerId ? `/dashboard/providers/${session.providerId}` : "/dashboard",
      locale,
    });
  }
  const canEdit = canManageCatalog(session.role);
  const provider = await getManagedProvider(session, id);
  if (!provider) notFound();
  const [t, tm, hours, timeOff, services] = await Promise.all([
    getTranslations("Providers"),
    getTranslations("Manage"),
    listProviderHours(session, id),
    listProviderTimeOff(session, id),
    listProviderServices(session, id),
  ]);
  const profileEditable = canEdit && !provider.locked;
  const hoursEditable = canEdit && !provider.locked && !hours.some((h) => h.locked);
  const showLocked = canEdit && (provider.locked || hours.some((h) => h.locked));
  const name = loc === "en" ? provider.name_en : provider.name_ar;
  const pick = (n: { name_ar: string; name_en: string | null }) =>
    loc === "en" ? n.name_en || n.name_ar : n.name_ar;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      {session.role === "provider" ? null : <BackLink href="/dashboard/providers" />}
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold sm:text-3xl" data-testid="provider-title">
          {name}
        </h1>
        {canEdit ? null : <p className="text-muted-foreground">{tm("readOnly")}</p>}
      </header>

      {showLocked ? <DemoLockedBanner /> : null}

      <section aria-labelledby="profile-h" className="flex flex-col gap-3">
        <h2 id="profile-h" className="font-heading text-xl font-semibold">
          {t("sections.profile")}
        </h2>
        <ProviderForm provider={provider} canEdit={profileEditable} />
      </section>

      <section aria-labelledby="services-h" className="flex flex-col gap-3">
        <h2 id="services-h" className="font-heading text-xl font-semibold">
          {t("sections.services")}
        </h2>
        {services.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted-foreground">
            {t("servicesNone")}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {services.map((s) => (
              <li key={s.id} className="rounded-full border border-line bg-paper px-3 py-1 text-sm">
                {pick(s)}
                {s.is_active ? "" : ` (${t("inactive")})`}
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <p className="text-sm text-muted-foreground">
            {t("servicesHint")}{" "}
            <Link href="/dashboard/services" className="font-medium text-cobalt-deep underline-offset-4 hover:underline">
              {t("servicesLink")}
            </Link>
          </p>
        ) : null}
      </section>

      <section aria-labelledby="hours-h" className="flex flex-col gap-3">
        <h2 id="hours-h" className="font-heading text-xl font-semibold">
          {t("hours.title")}
        </h2>
        {hours.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-3 text-sm text-muted-foreground">
            {t("hours.none")}
          </p>
        ) : null}
        <HoursEditor
          providerId={id}
          rows={hours}
          timezone={session.tenant.timezone}
          locale={loc}
          canEdit={hoursEditable}
        />
      </section>

      <section aria-labelledby="timeoff-h" className="flex flex-col gap-3">
        <h2 id="timeoff-h" className="font-heading text-xl font-semibold">
          {t("timeOff.title")}
        </h2>
        <TimeOffPanel
          providerId={id}
          rows={timeOff}
          timezone={session.tenant.timezone}
          locale={loc}
          canEdit={canEdit}
        />
      </section>
    </div>
  );
}
