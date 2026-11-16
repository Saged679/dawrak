import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { LoginForm } from "@/components/dashboard/login-form";
import { Link, redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { safeNextPath } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { NOINDEX } from "@/lib/seo/metadata";
import { demoEnabled } from "@/lib/auth/demo";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
};

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Auth" });
  return { title: t("metaTitle"), ...NOINDEX };
}

export default async function LoginPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const sp = await searchParams;
  const next = safeNextPath(Array.isArray(sp.next) ? sp.next[0] : sp.next);

  if (await getSession()) redirect({ href: next, locale });

  const t = await getTranslations("Auth");
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-12">
      <div className="flex flex-col gap-3">
        <Logo size={40} className="w-fit rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring" />
        <h1 className="mt-2 font-heading text-2xl font-semibold sm:text-3xl">{t("title")}</h1>
        <p className="text-muted-foreground">{t("noSignup")}</p>
      </div>
      <div className="rounded-2xl border border-line bg-paper p-5 sm:p-6">
        <LoginForm locale={locale} next={next} />
      </div>
      {demoEnabled() ? (
        <div className="flex flex-col gap-3 rounded-2xl bg-saffron-soft p-5">
          <p className="text-[#6b3f00]">{t("demoPrompt")}</p>
          <Link
            href="/demo"
            data-testid="login-try-demo"
            className="inline-flex min-h-12 items-center justify-center rounded-full bg-saffron px-6 font-heading text-lg font-semibold text-ink outline-none hover:bg-saffron/85 focus-visible:ring-3 focus-visible:ring-cobalt"
          >
            {t("tryDemo")}
          </Link>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link
          href="/"
          data-testid="login-back-home"
          className="inline-flex min-h-11 items-center rounded-md px-1 font-medium text-cobalt underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/60"
        >
          {t("backHome")}
        </Link>
        <Link
          href="/login"
          locale={locale === "ar" ? "en" : "ar"}
          className="rounded-md px-1 py-2 font-medium text-cobalt underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/60"
        >
          {locale === "ar" ? "English" : "العربية"}
        </Link>
      </div>
    </main>
  );
}
