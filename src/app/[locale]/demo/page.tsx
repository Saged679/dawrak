import type { Metadata } from "next";
import { Info, Scissors, Stethoscope } from "lucide-react";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { enterDemo } from "@/lib/auth/actions";
import { NOINDEX } from "@/lib/seo/metadata";
import { demoEnabled, type DemoPersona } from "@/lib/auth/demo";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
};

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Demo" });
  return { title: t("metaTitle"), ...NOINDEX };
}

const GROUPS: { id: "clinic" | "salon"; personas: DemoPersona[] }[] = [
  { id: "clinic", personas: ["clinic-owner", "clinic-reception"] },
  { id: "salon", personas: ["salon-owner"] },
];

const ERRORS = ["invalid", "rate", "signin", "busy"] as const;

export default async function DemoPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  if (!demoEnabled()) notFound();
  setRequestLocale(locale);
  const sp = await searchParams;
  const rawError = Array.isArray(sp.error) ? sp.error[0] : sp.error;
  const error = (ERRORS as readonly string[]).includes(rawError ?? "")
    ? (rawError as (typeof ERRORS)[number])
    : null;
  const t = await getTranslations("Demo");

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <Logo size={36} className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring" />
        <Link
          href="/"
          data-testid="back-home"
          className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-cobalt underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/60"
        >
          {t("backHome")}
        </Link>
      </div>
      <header className="flex flex-col gap-3">
        <h1 className="font-heading text-2xl font-semibold sm:text-4xl">{t("title")}</h1>
        <p className="max-w-[40em] text-lg text-muted-foreground">{t("lead")}</p>
        <p
          role="note"
          className="flex w-fit max-w-full items-start gap-2 rounded-xl bg-saffron-soft px-4 py-3 text-[#6b3f00]"
        >
          <Info className="mt-1 size-4 shrink-0" aria-hidden />
          <span>{t("notice")}</span>
        </p>
        {error ? (
          <p role="alert" className="w-fit max-w-full rounded-xl bg-[#fde8e6] px-4 py-3 text-[#7a1712]">
            {t(`errors.${error}`)}
          </p>
        ) : null}
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        {GROUPS.map((g) => {
          const Icon = g.id === "clinic" ? Stethoscope : Scissors;
          return (
            <section
              key={g.id}
              aria-labelledby={`g-${g.id}`}
              className="flex flex-col gap-4 rounded-2xl border border-line bg-paper p-5"
            >
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-sky text-cobalt-deep">
                  <Icon className="size-5" aria-hidden />
                </span>
                <div>
                  <h2 id={`g-${g.id}`} className="font-heading text-lg font-semibold">
                    {t(`${g.id}Title`)}
                  </h2>
                  <p className="text-sm text-muted-foreground">{t(`${g.id}Lead`)}</p>
                </div>
              </div>
              <ul className="flex flex-col gap-3">
                {g.personas.map((p) => (
                  <li key={p}>
                    <form action={enterDemo} className="flex flex-col gap-1">
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="persona" value={p} />
                      <button
                        type="submit"
                        data-testid={`demo-${p}`}
                        className="min-h-12 rounded-full bg-saffron px-6 font-heading font-semibold text-ink outline-none hover:bg-saffron/85 focus-visible:ring-3 focus-visible:ring-cobalt"
                      >
                        {t(`personas.${p}`)}
                      </button>
                      <span className="px-2 text-sm text-muted-foreground">{t(`personaHints.${p}`)}</span>
                    </form>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm font-medium">
        <Link
          href="/login"
          className="rounded-md py-2 text-cobalt underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/60"
        >
          {t("login")}
        </Link>
        <Link
          href="/demo"
          locale={locale === "ar" ? "en" : "ar"}
          className="rounded-md py-2 text-cobalt underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/60"
        >
          {locale === "ar" ? "English" : "العربية"}
        </Link>
      </nav>
    </main>
  );
}
