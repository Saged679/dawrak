import { DemoLockedBanner } from "@/components/dashboard/manage/demo-locked";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { BackLink } from "@/components/dashboard/manage/back-link";
import { ServiceForm } from "@/components/dashboard/manage/service-form";
import { routing } from "@/i18n/routing";
import { requireRole } from "@/lib/auth/session";
import { getService, listManagedProviders } from "@/lib/dashboard/catalog";

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Services" });
  return { title: t("editMetaTitle") };
}

export default async function EditServicePage({ params }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale) || !z.uuid().safeParse(id).success) notFound();
  setRequestLocale(locale);
  // Editing is owner only; a receptionist or provider typing the URL is sent to the overview.
  const session = await requireRole(locale, ["owner"]);
  const [t, service, providers] = await Promise.all([
    getTranslations("Services"),
    getService(session, id),
    listManagedProviders(session),
  ]);
  if (!service) notFound();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <BackLink href="/dashboard/services" />
      <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{t("editTitle")}</h1>
      {service.locked ? <DemoLockedBanner /> : null}
      <ServiceForm
        service={service}
        canEdit={!service.locked}
        currency={session.tenant.currency}
        providers={providers.map((p) => ({
          id: p.id,
          name: locale === "en" ? p.name_en || p.name_ar : p.name_ar,
          is_active: p.is_active,
        }))}
      />
    </div>
  );
}
