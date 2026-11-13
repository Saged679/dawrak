import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/dashboard/manage/back-link";
import { ServiceForm } from "@/components/dashboard/manage/service-form";
import { routing } from "@/i18n/routing";
import { requireRole } from "@/lib/auth/session";
import { listManagedProviders } from "@/lib/dashboard/catalog";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Services" });
  return { title: t("newMetaTitle") };
}

export default async function NewServicePage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const session = await requireRole(locale, ["owner"]);
  const [t, providers] = await Promise.all([getTranslations("Services"), listManagedProviders(session)]);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <BackLink href="/dashboard/services" />
      <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{t("newTitle")}</h1>
      <ServiceForm
        service={null}
        canEdit
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
