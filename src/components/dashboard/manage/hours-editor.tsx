"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { saveWorkingHours } from "@/app/[locale]/dashboard/providers/actions";
import { weekdayLong, type Loc } from "@/components/booking/dates";
import { useRouter } from "@/i18n/navigation";
import type { WorkingHourRow } from "@/lib/dashboard/catalog";
import { validateWeek, type DayHours, type TimeRange } from "@/lib/dashboard/manage";
import { Notice, type Msg } from "./form-ui";
import { inputClass, primaryBtn, quietBtn } from "./form-classes";

// Sunday first (Saudi week); weekday numbers follow Postgres extract(dow): 0 = Sunday.
const WEEK = [0, 1, 2, 3, 4, 5, 6];

function toDays(rows: WorkingHourRow[]): DayHours[] {
  return WEEK.map((weekday) => ({
    weekday,
    ranges: rows.filter((r) => r.weekday === weekday).map((r) => ({ start: r.start, end: r.end })),
  }));
}

export function HoursEditor({
  providerId,
  rows,
  timezone,
  locale,
  canEdit,
}: {
  providerId: string;
  rows: WorkingHourRow[];
  timezone: string;
  locale: Loc;
  canEdit: boolean;
}) {
  const t = useTranslations("Providers.hours");
  const te = useTranslations("Manage.errors");
  const tm = useTranslations("Manage");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [days, setDays] = useState<DayHours[]>(() => toDays(rows));
  const [msg, setMsg] = useState<Msg>(null);
  const [badDay, setBadDay] = useState<number | null>(null);

  function update(weekday: number, fn: (r: TimeRange[]) => TimeRange[]) {
    setMsg(null);
    setBadDay(null);
    setDays((cur) => cur.map((d) => (d.weekday === weekday ? { ...d, ranges: fn(d.ranges) } : d)));
  }

  function problem(code: "hours_invalid" | "hours_inverted" | "hours_overlap", weekday: number): Msg {
    setBadDay(weekday);
    const key = code === "hours_inverted" ? "inverted" : code === "hours_overlap" ? "overlap" : "invalid";
    return { kind: "error", text: t(`errors.${key}`, { day: weekdayLong(weekday, locale) }) };
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setMsg(null);
    setBadDay(null);
    // Same checks as the server (it repeats them): answer before the round trip.
    const check = validateWeek(days);
    if (!check.ok) {
      setMsg(problem(check.code, check.weekday));
      return;
    }
    start(async () => {
      const res = await saveWorkingHours({ providerId, days });
      if (res.ok) {
        setMsg({ kind: "ok", text: t("saved") });
        router.refresh();
      } else if (
        (res.code === "hours_invalid" || res.code === "hours_inverted" || res.code === "hours_overlap") &&
        res.weekday !== undefined
      ) {
        setMsg(problem(res.code, res.weekday));
      } else {
        setMsg({ kind: "error", text: te(res.code) });
      }
    });
  }

  return (
    <form method="post" onSubmit={submit} className="flex flex-col gap-4" noValidate data-testid="hours-form">
      <p className="text-sm text-muted-foreground">{t("lead", { zone: timezone })}</p>
      <fieldset disabled={!canEdit || pending} className="flex min-w-0 flex-col divide-y divide-line rounded-xl border border-line bg-paper">
        <legend className="sr-only">{t("title")}</legend>
        {days.map((d) => {
          const name = weekdayLong(d.weekday, locale);
          return (
            <div
              key={d.weekday}
              data-testid={`day-${d.weekday}`}
              data-invalid={badDay === d.weekday || undefined}
              className="flex flex-col gap-2 p-3 data-[invalid]:bg-[#fde8e6] sm:flex-row sm:items-start sm:gap-4"
            >
              <p className="min-h-11 shrink-0 pt-2.5 text-sm font-semibold sm:w-28">{name}</p>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {d.ranges.length === 0 ? (
                  <p className="pt-2.5 text-sm text-muted-foreground">{t("closed")}</p>
                ) : (
                  d.ranges.map((r, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2" data-testid={`range-${d.weekday}-${i}`}>
                      <input
                        type="time"
                        step={300}
                        required
                        dir="ltr"
                        aria-label={t("rangeStart", { day: name, n: i + 1 })}
                        aria-invalid={badDay === d.weekday || undefined}
                        value={r.start}
                        onChange={(e) =>
                          update(d.weekday, (list) => list.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))
                        }
                        className={`${inputClass} w-32`}
                      />
                      <span aria-hidden className="text-muted-foreground">
                        {t("to")}
                      </span>
                      <input
                        type="time"
                        step={300}
                        required
                        dir="ltr"
                        aria-label={t("rangeEnd", { day: name, n: i + 1 })}
                        aria-invalid={badDay === d.weekday || undefined}
                        value={r.end}
                        onChange={(e) =>
                          update(d.weekday, (list) => list.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))
                        }
                        className={`${inputClass} w-32`}
                      />
                      <button
                        type="button"
                        aria-label={t("removeRange", { day: name, n: i + 1 })}
                        onClick={() => update(d.weekday, (list) => list.filter((_, j) => j !== i))}
                        className="grid size-11 place-items-center rounded-full outline-none hover:bg-mist focus-visible:ring-3 focus-visible:ring-ring/60"
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </button>
                    </div>
                  ))
                )}
              </div>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() =>
                    update(d.weekday, (list) => [
                      ...list,
                      list.length === 0 ? { start: "09:00", end: "17:00" } : { start: list[list.length - 1].end, end: "" },
                    ])
                  }
                  data-testid={`add-range-${d.weekday}`}
                  className={`${quietBtn} self-start`}
                  aria-label={t("addRangeFor", { day: name })}
                >
                  <Plus className="size-4" aria-hidden />
                  {t("addRange")}
                </button>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <Notice msg={msg} testId="hours-msg" />
      {canEdit ? (
        <div className="flex">
          <button type="submit" disabled={pending} className={primaryBtn} data-testid="hours-save">
            {pending ? tm("saving") : t("save")}
          </button>
        </div>
      ) : null}
    </form>
  );
}
