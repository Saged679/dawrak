import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/dashboard/manage/back-link";
import { ProviderForm } from "@/components/dashboard/manage/provider-form";
import { routing } from "@/i18n/routing";
import { requireRole } from "@/lib/auth/session";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Providers" });
  return { title: t("newMetaTitle") };
}

export default async function NewProviderPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  await requireRole(locale, ["owner"]);
  const t = await getTranslations("Providers");
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <BackLink href="/dashboard/providers" />
      <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{t("newTitle")}</h1>
      <p className="text-muted-foreground">{t("newLead")}</p>
      <ProviderForm provider={null} canEdit />
    </div>
  );
}
