import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { SettingsForm } from "./settings-form";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Settings" });
  return { title: t("metaTitle") };
}

type TenantSettings = {
  name_ar: string;
  name_en: string;
  timezone: string;
  currency: string;
  deposit_enabled: boolean;
  deposit_type: "fixed" | "percent";
  deposit_value: number | string;
  logo_url: string | null;
  brand_color: string | null;
};

export default async function SettingsPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  // Owner only, enforced here and again in the save action and by the database.
  const session = await requireRole(locale, ["owner"]);
  const t = await getTranslations("Settings");
  const supabase = await createSupabaseServerClient();
  // Only the columns the owner may change (the same list the database grants UPDATE on).
  const { data, error } = await supabase
    .from("tenants")
    .select(
      "name_ar, name_en, timezone, currency, deposit_enabled, deposit_type, deposit_value, logo_url, brand_color",
    )
    .eq("id", session.tenant.id)
    .single();
  if (error) throw error;
  const tenant = data as unknown as TenantSettings;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{t("title")}</h1>
        <p className="text-muted-foreground">{t("lead")}</p>
      </header>
      <SettingsForm
        kind={session.tenant.kind}
        locale={locale as "ar" | "en"}
        demo={session.tenant.is_demo}
        initial={{
          name_ar: tenant.name_ar,
          name_en: tenant.name_en,
          timezone: tenant.timezone,
          currency: tenant.currency,
          deposit_enabled: tenant.deposit_enabled,
          deposit_type: tenant.deposit_type,
          deposit_value: String(Number(tenant.deposit_value)),
          logo_url: tenant.logo_url ?? "",
          brand_color: tenant.brand_color ?? "",
        }}
      />
    </div>
  );
}
