"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { formatClock, formatTime, type Loc } from "@/components/booking/dates";
import type { AppointmentStatus, Role } from "@/lib/auth/roles";
import { blockGeometry } from "@/lib/dashboard/time";
import { cn } from "@/lib/utils";
import { AppointmentDialog } from "./appointment-dialog";
import { STATUS_STYLE } from "./status";

export const PX_PER_HOUR = 72;

type Named = { name_ar: string; name_en: string | null };

export type CalendarItem = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  /** Owner only; null for everyone else (omitted on the server). */
  price: number | null;
  notes: string | null;
  providerId: string;
  provider: Named;
  serviceId: string;
  service: Named;
  customer: { full_name: string; phone: string };
  dateKey: string;
  startMin: number;
  endMin: number;
};

export type CalendarColumn = {
  key: string;
  title: string;
  subtitle: string | null;
  isToday: boolean;
  items: CalendarItem[];
};

export type CalendarViewProps = {
  columns: CalendarColumn[];
  startHour: number;
  endHour: number;
  timezone: string;
  currency: string;
  locale: Loc;
  role: Role;
  todayKey: string;
};

export function CalendarView(props: CalendarViewProps) {
  const { columns, startHour, endHour, timezone, locale } = props;
  const t = useTranslations("Calendar");
  const ts = useTranslations("Dash.status");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  // brief highlight on the block whose status just changed
  function flash(id: string) {
    setFlashId(null);
    window.clearTimeout(flashTimer.current);
    requestAnimationFrame(() => setFlashId(id));
    flashTimer.current = window.setTimeout(() => setFlashId(null), 1100);
  }

  const all = columns.flatMap((c) => c.items);
  const selected = all.find((i) => i.id === selectedId) ?? null;
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const height = hours.length * PX_PER_HOUR;
  const pick = (n: Named) => (locale === "en" ? n.name_en || n.name_ar : n.name_ar);
  const colMin = columns.length > 4 ? "9rem" : "11rem";

  return (
    <>
      <p className="text-xs text-muted-foreground sm:hidden">{t("scrollHint")}</p>
      {/* Only this container scrolls sideways; the page never does. */}
      <div
        role="region"
        aria-label={t("gridLabel")}
        tabIndex={0}
        className="overflow-x-auto rounded-xl border border-line bg-paper outline-none focus-visible:ring-3 focus-visible:ring-ring/60"
        data-testid="calendar-grid"
      >
        <div className="flex" style={{ minWidth: `calc(3.5rem + ${columns.length} * ${colMin})` }}>
          <div className="sticky start-0 z-20 w-14 shrink-0 border-e border-line bg-paper">
            <div className="h-14 border-b border-line" />
            <div className="relative" style={{ height }}>
              {hours.map((h, i) => (
                <span
                  key={h}
                  className={cn(
                    "absolute inset-x-0 pe-1 text-end text-[11px] text-muted-foreground tabular-nums",
                    i > 0 && "-translate-y-1/2",
                  )}
                  style={{ top: i * PX_PER_HOUR }}
                >
                  {formatClock(`${String(h).padStart(2, "0")}:00`, locale)}
                </span>
              ))}
            </div>
          </div>

          {columns.map((col) => (
            <div key={col.key} className="min-w-0 flex-1 border-e border-line last:border-e-0" style={{ minWidth: colMin }}>
              <div
                className={cn(
                  "flex h-14 flex-col justify-center border-b border-line px-2 text-center",
                  col.isToday && "bg-sky",
                )}
              >
                <p className="truncate font-heading text-sm font-semibold">{col.title}</p>
                {col.subtitle ? (
                  <p className="truncate text-xs text-muted-foreground">{col.subtitle}</p>
                ) : null}
              </div>
              <div className="relative" style={{ height }} data-testid={`col-${col.key}`}>
                {hours.map((h, i) => (
                  <div
                    key={h}
                    aria-hidden
                    className="absolute inset-x-0 border-t border-line/70"
                    style={{ top: i * PX_PER_HOUR }}
                  />
                ))}
                {col.items.length === 0 ? (
                  <p className="absolute inset-x-0 top-3 text-center text-xs text-muted-foreground">
                    {t("emptyDay")}
                  </p>
                ) : null}
                {col.items.map((item, idx) => {
                  const g = blockGeometry(item.startMin - startHour * 60, item.endMin - startHour * 60, 0, PX_PER_HOUR);
                  const s = STATUS_STYLE[item.status];
                  const Icon = s.icon;
                  const dim = item.status === "cancelled";
                  const label = ts(item.status);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid="appt-block"
                      data-status={item.status}
                      data-id={item.id}
                      aria-label={t("block", {
                        time: formatTime(item.startsAt, timezone, locale),
                        customer: item.customer.full_name,
                        service: pick(item.service),
                        status: label,
                      })}
                      onClick={() => {
                        setSelectedId(item.id);
                        setDialogOpen(true);
                      }}
                      style={{ top: g.top, height: g.height, ["--i" as string]: Math.min(idx, 8) }}
                      className={cn(
                        "m-block absolute flex flex-col justify-center overflow-hidden rounded-md border border-s-4 px-1.5 text-start text-[11px] leading-snug outline-none focus-visible:z-30 focus-visible:ring-3 focus-visible:ring-ring",
                        dim ? "end-1 z-0 w-[55%] opacity-80" : "inset-x-1 z-10",
                        s.box,
                        flashId === item.id && "m-flash",
                      )}
                    >
                      <span className="flex items-center gap-1 font-semibold">
                        <Icon className="size-3 shrink-0" aria-hidden />
                        <span className="truncate">{item.customer.full_name}</span>
                      </span>
                      <span className="truncate">
                        {formatTime(item.startsAt, timezone, locale)} · {label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <AppointmentDialog
        key={selected?.id ?? "none"}
        item={selected}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onClosed={() => setSelectedId(null)}
        onStatusChanged={flash}
        role={props.role}
        timezone={timezone}
        currency={props.currency}
        locale={locale}
        todayKey={props.todayKey}
      />
    </>
  );
}
