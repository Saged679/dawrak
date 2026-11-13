"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { addTimeOff, removeTimeOff } from "@/app/[locale]/dashboard/providers/actions";
import { dateKeyInZone, formatGregorian, formatTime, type Loc } from "@/components/booking/dates";
import { useRouter } from "@/i18n/navigation";
import type { TimeOffRow } from "@/lib/dashboard/catalog";
import { checkTimeOff } from "@/lib/dashboard/manage";
import { Field, inputClass, Notice, primaryBtn, type Msg } from "./form-ui";

export function TimeOffPanel({
  providerId,
  rows,
  timezone,
  locale,
  canEdit,
}: {
  providerId: string;
  rows: TimeOffRow[];
  timezone: string;
  locale: Loc;
  canEdit: boolean;
}) {
  const t = useTranslations("Providers.timeOff");
  const te = useTranslations("Manage.errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [bad, setBad] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");

  const stamp = (iso: string) =>
    `${formatGregorian(dateKeyInZone(iso, timezone), locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}, ${formatTime(iso, timezone, locale)}`;

  function add(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBad(false);
    if (!checkTimeOff(from, to, timezone).ok) {
      setBad(true);
      setMsg({ kind: "error", text: te("timeoff_invalid") });
      return;
    }
    start(async () => {
      const res = await addTimeOff({ providerId, start: from, end: to, reason });
      if (res.ok) {
        setFrom("");
        setTo("");
        setReason("");
        setMsg(
          res.conflicts > 0
            ? { kind: "warn", text: t("addedConflicts", { n: res.conflicts }) }
            : { kind: "ok", text: t("added") },
        );
        router.refresh();
      } else {
        setBad(res.code === "timeoff_invalid");
        setMsg({ kind: "error", text: te(res.code) });
      }
    });
  }

  function remove(id: string) {
    setMsg(null);
    start(async () => {
      const res = await removeTimeOff({ id });
      if (res.ok) {
        setMsg({ kind: "ok", text: t("removed") });
        router.refresh();
      } else {
        setMsg({ kind: "error", text: te(res.code) });
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-paper" data-testid="time-off-list">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0 text-sm">
                <p className="font-medium">
                  {stamp(r.startsAt)} <span className="text-muted-foreground">{t("until")}</span> {stamp(r.endsAt)}
                </p>
                {r.reason ? <p className="text-muted-foreground">{r.reason}</p> : null}
              </div>
              {canEdit ? (
                <button
                  type="button"
                  disabled={pending || r.locked}
                  title={r.locked ? te("demo_readonly") : undefined}
                  onClick={() => remove(r.id)}
                  aria-label={t("remove", { from: stamp(r.startsAt) })}
                  className="grid size-11 shrink-0 place-items-center rounded-full outline-none hover:bg-mist focus-visible:ring-3 focus-visible:ring-ring/60 disabled:opacity-50"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <form method="post" onSubmit={add} noValidate className="grid gap-3 sm:grid-cols-2" data-testid="time-off-form">
          <p className="text-sm text-muted-foreground sm:col-span-2">{t("lead", { zone: timezone })}</p>
          <Field label={t("from")} error={bad}>
            {(p) => <input {...p} name="from" type="datetime-local" required dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />}
          </Field>
          <Field label={t("to")} error={bad}>
            {(p) => <input {...p} name="to" type="datetime-local" required dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />}
          </Field>
          <Field label={t("reason")} className="sm:col-span-2">
            {(p) => <input {...p} name="reason" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />}
          </Field>
          <div className="sm:col-span-2">
            <button type="submit" disabled={pending} className={primaryBtn} data-testid="time-off-add">
              {t("add")}
            </button>
          </div>
        </form>
      ) : null}
      <Notice msg={msg} testId="time-off-msg" />
    </div>
  );
}
