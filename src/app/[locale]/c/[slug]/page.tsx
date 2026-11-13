import type { Metadata } from "next";
import { cache, type CSSProperties } from "react";
import { brandStyleVars } from "@/lib/db/brand";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { BookingFlow } from "@/components/booking/booking-flow";
import { ChatWidget } from "@/components/chat/chat-widget";
import { ClinicHeader } from "@/components/booking/clinic-header";
import { ClinicFacts } from "@/components/booking/clinic-facts";
import { buildClinicFacts } from "@/lib/geo/clinic-facts";
import { routing } from "@/i18n/routing";
import { buildClinicJsonLd, serializeJsonLd } from "@/lib/seo/jsonld";
import { buildClinicMetadata } from "@/lib/seo/metadata";
import { siteUrl } from "@/lib/seo/site";
import {
  getOpeningHours,
  getTenantBySlug,
  listProvidersByService,
  listServices,
} from "@/lib/db/public";

type Props = { params: Promise<{ locale: string; slug: string }> };

const loadTenant = cache(getTenantBySlug);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const tenant = await loadTenant(slug);
  if (!tenant) return { robots: { index: false, follow: false } };
  const t = await getTranslations({ locale, namespace: "Seo" });
  return buildClinicMetadata({ base: siteUrl(), locale, tenant, t });
}

export default async function ClinicPage({ params }: Props) {
  const { locale, slug } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const tenant = await loadTenant(slug);
  if (!tenant) notFound();

  const [services, hours, t] = await Promise.all([
    listServices(tenant.id),
    getOpeningHours(tenant.id),
    getTranslations("Clinic"),
  ]);
  const providersByService = await listProvidersByService(tenant.id, services);
  const name = locale === "en" ? tenant.name_en || tenant.name_ar : tenant.name_ar;

  const jsonLd = buildClinicJsonLd({ base: siteUrl(), locale, tenant, hours });

  // Only strictly validated #rrggbb values (or the default) ever reach the style attribute.
  const brandVars = brandStyleVars(tenant.brand_color) as CSSProperties;

  return (
    <div className="contents" style={brandVars}>
      {jsonLd ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />
      ) : null}
      <a
        href="#booking"
        className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-paper focus:px-3 focus:py-2 focus:text-cobalt focus-visible:outline-2 focus-visible:outline-ring"
      >
        {t("skipToBooking")}
      </a>
      <ClinicHeader
        slug={slug}
        locale={locale as "ar" | "en"}
        name={name}
        kind={tenant.kind}
        timezone={tenant.timezone}
        isDemo={tenant.is_demo}
        depositEnabled={tenant.deposit_enabled}
        hours={hours}
      />
      <main
        id="booking"
        className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-[minmax(0,1fr)] gap-6 px-4 pb-24 pt-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:pb-10"
      >
        {services.length === 0 ? (
          <p className="rounded-2xl border border-line bg-paper p-6 text-muted-foreground">
            {t("noServices")}
          </p>
        ) : (
          <BookingFlow
            slug={slug}
            tenantName={name}
            timezone={tenant.timezone}
            currency={tenant.currency}
            depositEnabled={tenant.deposit_enabled}
            services={services}
            providersByService={providersByService}
          />
        )}
        <aside className="min-w-0 lg:sticky lg:top-6">
          <ChatWidget slug={slug} tenantName={name} />
        </aside>
      </main>
      <ClinicFacts
        facts={buildClinicFacts(tenant, services, hours, locale as "ar" | "en")}
      />
    </div>
  );
}
