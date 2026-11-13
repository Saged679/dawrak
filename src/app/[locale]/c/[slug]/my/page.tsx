import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Info, Mail } from "lucide-react";
import { PortalShell } from "@/components/portal/portal-shell";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { isSafeSlug } from "@/lib/customer/policy";
import { getTenantBySlug } from "@/lib/db/public";
import { requestLink } from "./actions";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ sent?: string; error?: string }>;
};

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Portal" });
  return { title: t("requestMetaTitle"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

const ERRORS = ["invalid", "rate_limited", "generic"] as const;

export default async function RequestLinkPage({ params, searchParams }: Props) {
  const { locale, slug } = await params;
  if (!hasLocale(routing.locales, locale) || !isSafeSlug(slug)) notFound();
  setRequestLocale(locale);
  const tenant = await getTenantBySlug(slug);
  if (!tenant) notFound();
  const sp = await searchParams;
  const t = await getTranslations("Portal");
  const name = locale === "en" ? tenant.name_en || tenant.name_ar : tenant.name_ar;
  const error = (ERRORS as readonly string[]).includes(sp.error ?? "") ? (sp.error as (typeof ERRORS)[number]) : null;

  return (
    <PortalShell
      slug={slug}
      name={name}
      brandColor={tenant.brand_color}
      locale={locale}
      backLabel={t("backToClinic")}
    >
      <section aria-labelledby="req-title" className="rounded-2xl border border-line bg-paper p-4 shadow-sm sm:p-6">
        <h1 id="req-title" className="font-heading text-xl font-semibold text-ink">
          {t("requestTitle")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("requestLead")}</p>

        {tenant.is_demo ? (
          <p role="note" className="mt-4 flex items-start gap-2 rounded-xl bg-saffron-soft px-3 py-2 text-sm text-[#6b3f00]">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t("demoNotice")}</span>
          </p>
        ) : null}

        {sp.sent === "1" ? (
          <div role="status" data-testid="link-sent" className="mt-4 rounded-xl border border-cobalt bg-sky/60 p-3 text-sm text-ink">
            <p className="font-medium">{t("sentTitle")}</p>
            <p className="mt-1">{t("sentBody")}</p>
            {tenant.is_demo ? (
              <p className="mt-2">
                <Link
                  href="/demo/mailbox"
                  className="rounded-md py-2 font-medium text-cobalt underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {t("openMailbox")}
                </Link>
              </p>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
            {t(`requestErrors.${error}`)}
          </p>
        ) : null}

        <form method="post" action={requestLink} className="mt-4 flex flex-col gap-3">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="locale" value={locale} />
          <div className="flex flex-col gap-1">
            <label htmlFor="contact" className="text-sm font-medium text-ink">
              {t("contactLabel")}
            </label>
            <input
              id="contact"
              name="contact"
              type="text"
              inputMode="email"
              autoComplete="email"
              dir="ltr"
              required
              minLength={3}
              maxLength={200}
              aria-describedby="contact-hint"
              className="block w-full rounded-lg border border-line bg-paper px-3 py-2 text-start text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
            <p id="contact-hint" className="text-xs text-muted-foreground">
              {t("contactHint")}
            </p>
          </div>
          <Button type="submit" size="lg" className="h-11 w-full text-base sm:w-fit">
            <Mail aria-hidden /> {t("sendLink")}
          </Button>
        </form>
      </section>
    </PortalShell>
  );
}
