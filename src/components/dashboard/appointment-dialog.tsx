"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import {
  loadRescheduleOptions,
  rescheduleAppointment,
  setAppointmentStatus,
  type ProviderOption,
  type SlotOption,
} from "@/app/[locale]/dashboard/calendar/actions";
import {
  formatGregorian,
  formatHijri,
  formatMoney,
  formatTime,
  type Loc,
} from "@/components/booking/dates";
import { allowedStatusTargets, canReschedule, type Role } from "@/lib/auth/roles";
import type { StaffErrorCode } from "@/lib/dashboard/errors";
import type { CalendarItem } from "./calendar-view";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "./status";

type Props = {
  item: CalendarItem | null;
  /** Stays true until the exit transition has played; `onClosed` then clears the item. */
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
  onStatusChanged: (id: string) => void;
  role: Role;
  timezone: string;
  currency: string;
  locale: Loc;
  todayKey: string;
};

type Msg = { kind: "ok" | "error"; text: string } | null;

const btn =
  "inline-flex min-h-11 items-center justify-center rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/60 disabled:opacity-50";

export function AppointmentDialog({ item, open, onClose, onClosed, onStatusChanged, role, timezone, currency, locale, todayKey }: Props) {
  const td = useTranslations("Calendar.detail");
  const te = useTranslations("Calendar.errors");
  const ts = useTranslations("Dash.status");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [moving, setMoving] = useState(false);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [providerId, setProviderId] = useState("");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const seq = useRef(0);

  const fetchSlots = useCallback(
    async (appointmentId: string, prov: string, day: string) => {
      const n = ++seq.current;
      setSlots(null);
      setSlot(null);
      const res = await loadRescheduleOptions({ appointmentId, providerId: prov, date: day });
      if (n !== seq.current) return;
      if (res.ok) {
        setProviders(res.providers);
        setSlots(res.slots);
      } else {
        setSlots([]);
        setMsg({ kind: "error", text: te(res.code) });
      }
    },
    [te],
  );

  if (!item) {
    return <Dialog.Root open={false} />;
  }

  const pick = (n: { name_ar: string; name_en: string | null }) =>
    locale === "en" ? n.name_en || n.name_ar : n.name_ar;
  const locked = item.locked;
  const targets = allowedStatusTargets(role, item.status);
  const mayMove = canReschedule(role) && item.status !== "cancelled" && item.status !== "no_show";

  function fail(code: StaffErrorCode) {
    setMsg({ kind: "error", text: te(code) });
  }

  function changeStatus(status: (typeof targets)[number]) {
    if (!item) return;
    setMsg(null);
    startTransition(async () => {
      const res = await setAppointmentStatus({ appointmentId: item.id, status });
      if (res.ok) {
        setMsg({ kind: "ok", text: td("statusSaved") });
        onStatusChanged(item.id);
        router.refresh();
      } else {
        fail(res.code);
      }
    });
  }

  function startMove() {
    if (!item) return;
    setMsg(null);
    setMoving(true);
    const day = item.dateKey < todayKey ? todayKey : item.dateKey;
    setProviderId(item.providerId);
    setDate(day);
    void fetchSlots(item.id, item.providerId, day);
  }

  function confirmMove() {
    if (!item || !slot) return;
    setMsg(null);
    startTransition(async () => {
      const res = await rescheduleAppointment({
        appointmentId: item.id,
        providerId,
        startsAt: slot,
      });
      if (res.ok) {
        setMsg({ kind: "ok", text: td("moved") });
        setMoving(false);
        router.refresh();
      } else {
        fail(res.code);
        if (res.code === "slot_taken") void fetchSlots(item.id, providerId, date);
      }
    });
  }

  const field =
    "h-11 w-full rounded-lg border border-line bg-paper px-3 text-base outline-none focus-visible:border-cobalt focus-visible:ring-3 focus-visible:ring-ring/40";

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => !o && onClose()}
      onOpenChangeComplete={(o) => {
        if (!o) onClosed();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="m-backdrop fixed inset-0 z-50 bg-ink/40" />
        <Dialog.Popup
          data-testid="appt-dialog"
          className="m-sheet fixed inset-y-0 end-0 z-50 flex w-full max-w-md flex-col gap-4 overflow-y-auto border-s border-line bg-paper p-5 text-ink shadow-xl outline-none"
        >
          <div className="flex items-start justify-between gap-3">
            <Dialog.Title className="font-heading text-xl font-semibold">{td("title")}</Dialog.Title>
            <Dialog.Close
              aria-label={td("close")}
              className="grid size-11 shrink-0 place-items-center rounded-full outline-none hover:bg-mist focus-visible:ring-3 focus-visible:ring-ring/60"
            >
              <X className="size-5" aria-hidden />
            </Dialog.Close>
          </div>

          <StatusBadge status={item.status} label={ts(item.status)} className="w-fit" />

          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{td("customer")}</dt>
            <dd className="font-medium">{item.customer.full_name}</dd>
            <dt className="text-muted-foreground">{td("phone")}</dt>
            <dd dir="ltr" className="text-start">
              {item.customer.phone}
            </dd>
            <dt className="text-muted-foreground">{td("service")}</dt>
            <dd>{pick(item.service)}</dd>
            <dt className="text-muted-foreground">{td("provider")}</dt>
            <dd>{pick(item.provider)}</dd>
            <dt className="text-muted-foreground">{td("time")}</dt>
            <dd>
              {formatGregorian(item.dateKey, locale, { weekday: "long", day: "numeric", month: "long" })}
              <br />
              <span lang={locale} className="text-muted-foreground">
                {formatHijri(item.dateKey, undefined, locale)}
              </span>
              <br />
              {formatTime(item.startsAt, timezone, locale)} - {formatTime(item.endsAt, timezone, locale)}
            </dd>
            {item.price !== null ? (
              <>
                <dt className="text-muted-foreground">{td("price")}</dt>
                <dd>{formatMoney(item.price, currency, locale)}</dd>
              </>
            ) : null}
            {item.notes ? (
              <>
                <dt className="text-muted-foreground">{td("notes")}</dt>
                <dd>{item.notes}</dd>
              </>
            ) : null}
          </dl>

          {msg ? (
            <p
              role={msg.kind === "error" ? "alert" : "status"}
              className={
                (msg.kind === "error"
                  ? "m-rise rounded-lg bg-[#fde8e6] px-3 py-2 text-sm text-[#7a1712]"
                  : "m-rise rounded-lg bg-[#dff3ec] px-3 py-2 text-sm text-[#0f4d3b]")
              }
              data-testid="dialog-msg"
            >
              {msg.text}
            </p>
          ) : null}

          {locked && (targets.length > 0 || mayMove) ? (
            <p role="note" data-testid="dialog-demo-locked" className="text-sm text-muted-foreground">
              {td("demoLocked")}
            </p>
          ) : null}

          {targets.length === 0 && !mayMove ? (
            <p className="text-sm text-muted-foreground">{td("readOnly")}</p>
          ) : null}

          {targets.length > 0 ? (
            <section aria-labelledby="chg" className="flex flex-col gap-2">
              <h3 id="chg" className="font-heading text-sm font-semibold">
                {td("changeStatus")}
              </h3>
              <div className="flex flex-wrap gap-2">
                {targets.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={pending || locked}
                    title={locked ? td("demoLocked") : undefined}
                    data-testid={`set-${s}`}
                    onClick={() => changeStatus(s)}
                    className={`${btn} border-line bg-paper hover:bg-mist`}
                  >
                    {td("markAs", { status: ts(s) })}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {mayMove ? (
            moving ? (
              <section aria-labelledby="mv" className="flex flex-col gap-3 rounded-xl bg-mist p-3">
                <h3 id="mv" className="font-heading text-sm font-semibold">
                  {td("reschedule")}
                </h3>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  {td("rescheduleProvider")}
                  <select
                    className={field}
                    value={providerId}
                    data-testid="mv-provider"
                    onChange={(e) => {
                      setProviderId(e.target.value);
                      setMsg(null);
                      void fetchSlots(item.id, e.target.value, date);
                    }}
                  >
                    {(providers.length ? providers : [{ id: item.providerId, ...item.provider }]).map((p) => (
                      <option key={p.id} value={p.id}>
                        {pick(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  {td("rescheduleDate")}
                  <input
                    type="date"
                    className={field}
                    dir="ltr"
                    value={date}
                    min={todayKey}
                    data-testid="mv-date"
                    onChange={(e) => {
                      if (!e.target.value) return;
                      setDate(e.target.value);
                      setMsg(null);
                      void fetchSlots(item.id, providerId, e.target.value);
                    }}
                  />
                </label>
                <div role="group" aria-label={td("slotsLabel")} className="flex flex-col gap-2">
                  {slots === null ? (
                    <>
                      <p className="text-sm text-muted-foreground">{td("slotsLoading")}</p>
                      <div className="flex flex-wrap gap-2" aria-hidden>
                        {[0, 1, 2, 3].map((n) => (
                          <Skeleton key={n} className="h-11 w-20 rounded-full" />
                        ))}
                      </div>
                    </>
                  ) : slots.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{td("slotsEmpty")}</p>
                  ) : (
                    <div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto">
                      {slots.map((s) => (
                        <button
                          key={s.start}
                          type="button"
                          data-testid="mv-slot"
                          aria-pressed={slot === s.start}
                          onClick={() => setSlot(s.start)}
                          className={`${btn} min-w-20 tabular-nums ${
                            slot === s.start
                              ? "border-cobalt bg-cobalt text-white"
                              : "border-line bg-paper hover:bg-sky"
                          }`}
                        >
                          {formatTime(s.start, timezone, locale)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!slot || pending}
                    data-testid="mv-confirm"
                    onClick={confirmMove}
                    className={`${btn} border-transparent bg-cobalt text-white hover:bg-cobalt-deep`}
                  >
                    {pending ? td("saving") : td("confirmMove")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMoving(false)}
                    className={`${btn} border-line bg-paper hover:bg-mist`}
                  >
                    {td("cancelReschedule")}
                  </button>
                </div>
              </section>
            ) : (
              <button
                type="button"
                disabled={pending || locked}
                title={locked ? td("demoLocked") : undefined}
                data-testid="mv-open"
                onClick={startMove}
                className={`${btn} w-fit border-cobalt text-cobalt-deep hover:bg-sky`}
              >
                {td("reschedule")}
              </button>
            )
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
