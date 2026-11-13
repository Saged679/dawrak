import { getTranslations } from "next-intl/server";
import type { ClinicFactsData } from "@/lib/geo/clinic-facts";

export type ClinicFactsLabels = {
  title: string;
  lead: string;
  kind: string;
  kindValue: string;
  services: string;
  noServices: string;
  hours: string;
  hoursNone: string;
  hoursLine: (days: string, start: string, end: string) => string;
  timezone: string;
  booking: string;
  bookingValue: string;
  languages: string;
  languagesValue: string;
  calendar: string;
  calendarValue: string;
  deposit: string;
  depositValue: string;
  demo: string;
  demoValue: string;
};

/** Plain, visible, semantic facts block (definition list) that answer engines can parse. */
export function ClinicFactsView({ facts, l }: { facts: ClinicFactsData; l: ClinicFactsLabels }) {
  return (
    <section
      aria-labelledby="clinic-facts-title"
      className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6"
    >
      <h2 id="clinic-facts-title" className="font-heading text-xl font-semibold">
        {l.title}: {facts.name}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{l.lead}</p>
      <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]">
        <dt className="font-medium">{l.kind}</dt>
        <dd>{l.kindValue}</dd>
        <dt className="font-medium">{l.services}</dt>
        <dd>
          {facts.services.length === 0 ? (
            l.noServices
          ) : (
            <ul className="flex flex-col gap-1">
              {facts.services.map((s, i) => (
                <li key={i}>
                  {s.name}: {s.duration}, {s.price}
                  {s.description ? `. ${s.description}` : ""}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt className="font-medium">{l.hours}</dt>
        <dd>
          {facts.hours.length === 0 ? (
            l.hoursNone
          ) : (
            <ul className="flex flex-col gap-1">
              {facts.hours.map((h, i) => (
                <li key={i}>{l.hoursLine(h.days, h.start, h.end)}</li>
              ))}
            </ul>
          )}
        </dd>
        <dt className="font-medium">{l.timezone}</dt>
        <dd>{facts.timezone}</dd>
        <dt className="font-medium">{l.booking}</dt>
        <dd>{l.bookingValue}</dd>
        <dt className="font-medium">{l.languages}</dt>
        <dd>{l.languagesValue}</dd>
        <dt className="font-medium">{l.calendar}</dt>
        <dd>{l.calendarValue}</dd>
        {facts.depositEnabled ? (
          <>
            <dt className="font-medium">{l.deposit}</dt>
            <dd>{l.depositValue}</dd>
          </>
        ) : null}
        {facts.isDemo ? (
          <>
            <dt className="font-medium">{l.demo}</dt>
            <dd>{l.demoValue}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

export async function ClinicFacts({ facts }: { facts: ClinicFactsData }) {
  const t = await getTranslations("Facts.clinic");
  return (
    <ClinicFactsView
      facts={facts}
      l={{
        title: t("title"),
        lead: t("lead"),
        kind: t("kind"),
        kindValue: t(facts.kind === "salon" ? "kindSalon" : "kindClinic"),
        services: t("services"),
        noServices: t("noServices"),
        hours: t("hours"),
        hoursNone: t("hoursNone"),
        hoursLine: (days, start, end) => t("hoursLine", { days, start, end }),
        timezone: t("timezone"),
        booking: t("booking"),
        bookingValue: t("bookingValue"),
        languages: t("languages"),
        languagesValue: t("languagesValue"),
        calendar: t("calendar"),
        calendarValue: t("calendarValue"),
        deposit: t("deposit"),
        depositValue: t("depositValue"),
        demo: t("demo"),
        demoValue: t("demoValue"),
      }}
    />
  );
}
