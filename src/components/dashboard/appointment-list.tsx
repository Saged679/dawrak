import { getTranslations } from "next-intl/server";
import { formatGregorian, formatTime, type Loc } from "@/components/booking/dates";
import { dateKeyInZone } from "@/lib/dashboard/time";
import type { AppointmentRow } from "@/lib/dashboard/queries";
import { StatusBadge } from "./status";

export async function AppointmentList({
  rows,
  locale,
  timezone,
  showDate,
  empty,
}: {
  rows: AppointmentRow[];
  locale: Loc;
  timezone: string;
  showDate?: boolean;
  empty: string;
}) {
  const t = await getTranslations();
  if (rows.length === 0) {
    return <p className="rounded-xl border border-dashed border-line p-4 text-muted-foreground">{empty}</p>;
  }
  const pick = (n: { name_ar: string; name_en: string | null }) =>
    locale === "en" ? n.name_en || n.name_ar : n.name_ar;

  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
          <div className="w-28 shrink-0">
            <p className="font-heading font-semibold tabular-nums">
              {formatTime(r.startsAt, timezone, locale)}
            </p>
            {showDate ? (
              <p className="text-xs text-muted-foreground">
                {formatGregorian(dateKeyInZone(r.startsAt, timezone), locale, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                })}
              </p>
            ) : null}
          </div>
          <div className="min-w-0 flex-1 basis-40">
            <p className="truncate font-medium">{r.customer.full_name}</p>
            <p className="truncate text-sm text-muted-foreground">
              {pick(r.service)} · {t("Overview.with", { name: pick(r.provider) })}
            </p>
          </div>
          <StatusBadge status={r.status} label={t(`Dash.status.${r.status}`)} />
        </li>
      ))}
    </ul>
  );
}
