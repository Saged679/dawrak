import { getTranslations } from "next-intl/server";
import { Clock3, Stethoscope, Scissors } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { formatClock, groupHours, weekdayName, type Loc } from "./dates";

type Props = {
  slug: string;
  locale: Loc;
  name: string;
  kind: "clinic" | "salon";
  timezone: string;
  isDemo: boolean;
  depositEnabled: boolean;
  hours: { weekday: number; start: string; end: string }[];
};

export async function ClinicHeader({
  slug,
  locale,
  name,
  kind,
  timezone,
  isDemo,
  depositEnabled,
  hours,
}: Props) {
  const t = await getTranslations("Clinic");
  const groups = groupHours(hours);
  const Icon = kind === "salon" ? Scissors : Stethoscope;

  return (
    <header className="bg-cobalt text-(--brand-fg)">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 rounded-full bg-(--brand-fg)/15 px-3 py-1 text-sm font-medium">
            <Icon className="size-4" aria-hidden />
            {t(`kind.${kind}`)}
            {isDemo ? <span className="text-saffron">- {t("demoBadge")}</span> : null}
          </span>
          <div className="flex items-center gap-1">
          <Link
            href={`/c/${slug}/my`}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-(--brand-fg) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-fg)"
          >
            {t("myAppointments")}
          </Link>
          <Link
            href={`/c/${slug}`}
            locale={locale === "ar" ? "en" : "ar"}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-(--brand-fg) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-fg)"
          >
            {t("switchLocale")}
          </Link>
          </div>
        </div>
        <h1 className="font-heading text-2xl font-semibold sm:text-4xl">{name}</h1>
        <section aria-labelledby="hours-title" className="max-w-[40em]">
          <h2 id="hours-title" className="sr-only">
            {t("hoursTitle")}
          </h2>
          <div className="flex items-start gap-2 text-sm text-(--brand-fg)/90">
            <Clock3 className="mt-1 size-4 shrink-0" aria-hidden />
            {groups.length === 0 ? (
              <p>{t("hoursUnknown")}</p>
            ) : (
              <ul className="flex flex-col">
                {groups.map((g) => (
                  <li key={`${g.from}-${g.to}`}>
                    {t("hoursLine", {
                      days:
                        g.from === g.to
                          ? t("hoursDay", { day: weekdayName(g.from, locale) })
                          : t("hoursRange", {
                              from: weekdayName(g.from, locale),
                              to: weekdayName(g.to, locale),
                            }),
                      start: formatClock(g.start, locale),
                      end: formatClock(g.end, locale),
                    })}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="mt-1 ps-6 text-xs text-(--brand-fg)/75">{t("timezone", { zone: timezone })}</p>
          {depositEnabled ? <p className="mt-1 ps-6 text-xs text-(--brand-fg)/85">{t("depositNote")}</p> : null}
        </section>
      </div>
    </header>
  );
}
