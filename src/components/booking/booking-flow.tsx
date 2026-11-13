"use client";

import { useActionState, useCallback, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarCheck, CheckCircle2, Clock, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { loadSlots, submitBooking } from "@/app/[locale]/c/[slug]/actions";
import { normalizePhone, type BookingState } from "@/lib/db/schema";
import type { PublicProvider, PublicService, Slot } from "@/lib/db/public";
import {
  addDays,
  BOOKING_WINDOW_DAYS,
  dateKeyInZone,
  formatGregorian,
  formatHijri,
  formatMoney,
  formatNumber,
  formatTime,
  type Loc,
} from "./dates";
import { BookingConfirmation } from "./booking-confirmation";

type Props = {
  slug: string;
  tenantName: string;
  timezone: string;
  currency: string;
  depositEnabled: boolean;
  services: PublicService[];
  providersByService: Record<string, PublicProvider[]>;
};

const STEPS = ["service", "provider", "time", "details", "confirm"] as const;
type StepKey = (typeof STEPS)[number];

const ANY = "any";

const pick = (loc: Loc, ar: string | null, en: string | null) =>
  loc === "en" ? en || ar || "" : ar || en || "";

const fieldClass =
  "block w-full rounded-lg border border-line bg-paper px-3 py-2 text-base text-ink placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[invalid=true]:border-destructive";

const cardClass =
  "block rounded-xl border-[1.5px] border-line bg-paper px-4 py-3 text-start transition-colors peer-checked:border-cobalt peer-checked:bg-sky peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:cursor-not-allowed peer-disabled:opacity-50";

export function BookingFlow(props: Props) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <BookingFlowInner
      key={resetKey}
      {...props}
      onReset={() => setResetKey((k) => k + 1)}
    />
  );
}

function BookingFlowInner({
  slug,
  tenantName,
  timezone,
  currency,
  depositEnabled,
  services,
  providersByService,
  onReset,
}: Props & { onReset: () => void }) {
  const t = useTranslations("Booking");
  const loc = useLocale() as Loc;

  const [step, setStep] = useState<number>(0);
  const [serviceId, setServiceId] = useState<string>("");
  const [providerKey, setProviderKey] = useState<string>(ANY);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slotsStatus, setSlotsStatus] = useState<"idle" | "loading" | "error">("idle");
  const [slotsErrorCode, setSlotsErrorCode] = useState<string>("slotsFailed");
  const [days, setDays] = useState<string[]>([]);
  const [dateKey, setDateKey] = useState<string>("");
  const [slotStart, setSlotStart] = useState<string>("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [detailErrors, setDetailErrors] = useState<Partial<Record<"fullName" | "phone" | "email", boolean>>>({});
  const [state, formAction, pending] = useActionState<BookingState, FormData>(submitBooking, {
    status: "idle",
  });
  const [dismissed, setDismissed] = useState<BookingState | null>(null);
  const requestId = useRef(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const service = services.find((s) => s.id === serviceId);
  const providers = serviceId ? (providersByService[serviceId] ?? []) : [];

  // Slots grouped by day, one entry per start time (first provider wins for "any available").
  const slotsByDay = new Map<string, Slot[]>();
  for (const s of slots ?? []) {
    const k = dateKeyInZone(s.start, timezone);
    const list = slotsByDay.get(k) ?? [];
    if (!list.some((x) => x.start === s.start)) list.push(s);
    slotsByDay.set(k, list);
  }
  const daySlots = slotsByDay.get(dateKey) ?? [];
  const chosenSlot = daySlots.find((s) => s.start === slotStart);
  const chosenProvider = providers.find((p) => p.id === chosenSlot?.providerId);

  const goTo = useCallback(
    (n: number) => {
      setDismissed(state);
      setStep(n);
    },
    [state],
  );

  async function fetchSlots(sId: string, pKey: string) {
    const id = ++requestId.current;
    setSlotsStatus("loading");
    setSlots(null);
    const today = dateKeyInZone(new Date(), timezone);
    const dateTo = addDays(today, BOOKING_WINDOW_DAYS - 1);
    const res = await loadSlots({
      slug,
      serviceId: sId,
      providerId: pKey === ANY ? null : pKey,
      dateFrom: today,
      dateTo,
    });
    if (id !== requestId.current) return;
    if (!res.ok) {
      setSlotsErrorCode(res.code === "rate_limited" ? "rate_limited" : "slotsFailed");
      setSlotsStatus("error");
      return;
    }
    const keys = Array.from({ length: BOOKING_WINDOW_DAYS }, (_, i) => addDays(today, i));
    setDays(keys);
    setSlots(res.slots);
    setSlotsStatus("idle");
    const firstWithSlots = keys.find((k) =>
      res.slots.some((s) => dateKeyInZone(s.start, timezone) === k),
    );
    setDateKey(firstWithSlots ?? keys[0]);
    setSlotStart("");
  }

  async function goToTime(sId = serviceId, pKey = providerKey) {
    goTo(2);
    await fetchSlots(sId, pKey);
  }

  function validateDetails(): boolean {
    const errs: typeof detailErrors = {};
    if (fullName.trim().length < 2) errs.fullName = true;
    if (!normalizePhone(phone)) errs.phone = true;
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) errs.email = true;
    setDetailErrors(errs);
    return Object.keys(errs).length === 0;
  }

  if (state.status === "success" && service) {
    return (
      <BookingConfirmation
        booking={state.booking}
        tenantName={tenantName}
        service={service}
        providerName={chosenProvider ? pick(loc, chosenProvider.name_ar, chosenProvider.name_en) : ""}
        timezone={timezone}
        onReset={onReset}
      />
    );
  }

  const showError = state.status === "error" && state !== dismissed;
  const errorCode = state.status === "error" ? state.code : "generic";

  const summaries: Record<StepKey, string> = {
    service: service ? pick(loc, service.name_ar, service.name_en) : "",
    provider:
      providerKey === ANY
        ? t("anyProvider")
        : (() => {
            const p = providers.find((x) => x.id === providerKey);
            return p ? pick(loc, p.name_ar, p.name_en) : "";
          })(),
    time:
      chosenSlot && dateKey
        ? `${formatGregorian(dateKey, loc)} - ${formatTime(chosenSlot.start, timezone, loc)}`
        : "",
    details: fullName.trim() ? `${fullName.trim()} - ${phone.trim()}` : "",
    confirm: "",
  };

  return (
    <form
      method="post"
      action={formAction}
      onSubmit={(e) => {
        if (step !== STEPS.length - 1) e.preventDefault();
      }}
      noValidate
      aria-labelledby="booking-title"
      className="min-w-0 rounded-2xl border border-line bg-paper p-4 shadow-sm sm:p-6"
    >
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="locale" value={loc} />
      <input type="hidden" name="serviceId" value={serviceId} />
      <input type="hidden" name="providerId" value={chosenSlot?.providerId ?? ""} />
      <input type="hidden" name="startsAt" value={slotStart} />
      <input type="hidden" name="fullName" value={fullName} />
      <input type="hidden" name="phone" value={phone} />
      <input type="hidden" name="email" value={email} />

      <h2
        id="booking-title"
        ref={headingRef}
        tabIndex={-1}
        className="font-heading text-xl font-semibold text-ink"
      >
        {t("title")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("lead")}</p>

      <ol className="mt-5 flex flex-col gap-3">
        {STEPS.map((key, i) => {
          const done = i < step;
          const current = i === step;
          return (
            <li
              key={key}
              aria-current={current ? "step" : undefined}
              className={cn(
                "min-w-0 rounded-xl border p-3 sm:p-4",
                current ? "border-cobalt bg-mist/60" : "border-line",
                !current && !done && "opacity-60",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold",
                      done ? "bg-cobalt text-(--brand-fg)" : "bg-sky text-cobalt-deep",
                    )}
                  >
                    {done ? <CheckCircle2 className="size-4" /> : formatNumber(i + 1, loc)}
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-heading text-base font-medium text-ink">
                      <span className="sr-only">
                        {t("stepLabel", { n: formatNumber(i + 1, loc), total: formatNumber(STEPS.length, loc) })}
                        {": "}
                      </span>
                      {t(`steps.${key}`)}
                    </h3>
                    {done && summaries[key] ? (
                      <p className="truncate text-sm text-muted-foreground">{summaries[key]}</p>
                    ) : null}
                  </div>
                </div>
                {done ? (
                  <button
                    type="button"
                    onClick={() => goTo(i)}
                    className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-cobalt underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {t("change")}
                    <span className="sr-only"> {t(`steps.${key}`)}</span>
                  </button>
                ) : null}
              </div>

              {current ? (
                <div className="mt-4 min-w-0">
                  {key === "service" ? (
                    <fieldset className="min-w-0">
                      <legend className="sr-only">{t("serviceLegend")}</legend>
                      <div className="flex flex-col gap-2">
                        {services.map((s) => (
                          <label key={s.id} className="relative block">
                            <input
                              type="radio"
                              name="service-choice"
                              value={s.id}
                              checked={serviceId === s.id}
                              onChange={() => {
                                setServiceId(s.id);
                                setProviderKey(ANY);
                                setSlots(null);
                                setSlotStart("");
                              }}
                              className="peer sr-only"
                            />
                            <span className={cardClass}>
                              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                                <span className="font-medium text-ink">
                                  {pick(loc, s.name_ar, s.name_en)}
                                </span>
                                <span className="text-sm font-semibold text-cobalt-deep">
                                  {formatMoney(s.price, currency, loc)}
                                </span>
                              </span>
                              <span className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground">
                                <Clock className="size-3.5" aria-hidden />
                                {t("minutes", { n: formatNumber(s.duration_min, loc) })}
                                {pick(loc, s.description_ar, s.description_en)
                                  ? ` - ${pick(loc, s.description_ar, s.description_en)}`
                                  : ""}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : null}

                  {key === "provider" ? (
                    <fieldset className="min-w-0">
                      <legend className="sr-only">{t("providerLegend")}</legend>
                      <div className="flex flex-col gap-2">
                        <label className="relative block">
                          <input
                            type="radio"
                            name="provider-choice"
                            value={ANY}
                            checked={providerKey === ANY}
                            onChange={() => setProviderKey(ANY)}
                            className="peer sr-only"
                          />
                          <span className={cardClass}>
                            <span className="font-medium text-ink">{t("anyProvider")}</span>
                            <span className="block text-sm text-muted-foreground">
                              {t("anyProviderHint")}
                            </span>
                          </span>
                        </label>
                        {providers.map((p) => (
                          <label key={p.id} className="relative block">
                            <input
                              type="radio"
                              name="provider-choice"
                              value={p.id}
                              checked={providerKey === p.id}
                              onChange={() => setProviderKey(p.id)}
                              className="peer sr-only"
                            />
                            <span className={cardClass}>
                              <span className="font-medium text-ink">
                                {pick(loc, p.name_ar, p.name_en)}
                              </span>
                              {pick(loc, p.title_ar, p.title_en) ? (
                                <span className="block text-sm text-muted-foreground">
                                  {pick(loc, p.title_ar, p.title_en)}
                                </span>
                              ) : null}
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : null}

                  {key === "time" ? (
                    <div aria-live="polite">
                      {slotsStatus === "loading" ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
                          {t("loadingSlots")}
                        </p>
                      ) : null}
                      {slotsStatus === "error" ? (
                        <div role="alert" className="flex flex-col items-start gap-2 text-sm text-destructive">
                          <p>{t(`errors.${slotsErrorCode}`)}</p>
                          <Button type="button" variant="outline" size="sm" onClick={() => void fetchSlots(serviceId, providerKey)}>
                            {t("retry")}
                          </Button>
                        </div>
                      ) : null}
                      {slots && slotsStatus === "idle" ? (
                        slots.length === 0 ? (
                          <p className="text-sm text-muted-foreground">{t("noSlotsAll")}</p>
                        ) : (
                          <div className="flex flex-col gap-4">
                            <fieldset className="min-w-0">
                              <legend className="mb-2 text-sm font-medium text-ink">{t("dateLegend")}</legend>
                              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
                                {days.map((k) => {
                                  const count = slotsByDay.get(k)?.length ?? 0;
                                  return (
                                    <label key={k} className="relative shrink-0">
                                      <input
                                        type="radio"
                                        name="day-choice"
                                        value={k}
                                        disabled={count === 0}
                                        checked={dateKey === k}
                                        onChange={() => {
                                          setDateKey(k);
                                          setSlotStart("");
                                        }}
                                        className="peer sr-only"
                                      />
                                      <span className={cn(cardClass, "min-w-24 px-3 py-2 text-center")}>
                                        <span className="block text-sm font-medium text-ink">
                                          {formatGregorian(k, loc, { weekday: "short", day: "numeric", month: "short" })}
                                        </span>
                                        <span className="block text-xs text-muted-foreground">
                                          {formatHijri(k, { day: "numeric", month: "short" }, loc)}
                                        </span>
                                        <span className="block text-xs text-cobalt-deep">
                                          {count === 0 ? t("noSlotsDayShort") : t("slotsCount", { n: formatNumber(count, loc) })}
                                        </span>
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            </fieldset>

                            {dateKey ? (
                              <fieldset className="min-w-0">
                                <legend className="mb-1 text-sm font-medium text-ink">
                                  {t("timesFor", { date: formatGregorian(dateKey, loc) })}
                                </legend>
                                <p className="mb-2 text-xs text-muted-foreground">
                                  {t("hijriLabel")} {formatHijri(dateKey, undefined, loc)} - {t("timezoneNote", { zone: timezone })}
                                </p>
                                {daySlots.length === 0 ? (
                                  <p className="text-sm text-muted-foreground">{t("noSlotsDay")}</p>
                                ) : (
                                  <div className="flex flex-wrap gap-2">
                                    {daySlots.map((s) => (
                                      <label key={s.start} className="relative">
                                        <input
                                          type="radio"
                                          name="slot-choice"
                                          value={s.start}
                                          checked={slotStart === s.start}
                                          onChange={() => setSlotStart(s.start)}
                                          className="peer sr-only"
                                        />
                                        <span className="block rounded-full border-[1.5px] border-line bg-paper px-4 py-1.5 text-sm transition-colors peer-checked:border-cobalt peer-checked:bg-sky peer-checked:font-semibold peer-checked:text-cobalt-deep peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring">
                                          {formatTime(s.start, timezone, loc)}
                                        </span>
                                      </label>
                                    ))}
                                  </div>
                                )}
                              </fieldset>
                            ) : null}
                          </div>
                        )
                      ) : null}
                    </div>
                  ) : null}

                  {key === "details" ? (
                    <div
                      className="flex flex-col gap-4"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (validateDetails()) goTo(4);
                        }
                      }}
                    >
                      <Field
                        id="fullName"
                        label={t("name")}
                        error={detailErrors.fullName ? t("fieldErrors.fullName") : undefined}
                      >
                        <input
                          id="fullName"
                          type="text"
                          autoComplete="name"
                          required
                          maxLength={100}
                          value={fullName}
                          onChange={(e) => setFullName(e.target.value)}
                          aria-invalid={detailErrors.fullName ? true : undefined}
                          aria-describedby={detailErrors.fullName ? "fullName-error" : undefined}
                          className={fieldClass}
                        />
                      </Field>
                      <Field
                        id="phone"
                        label={t("phone")}
                        hint={t("phoneHint")}
                        error={detailErrors.phone ? t("fieldErrors.phone") : undefined}
                      >
                        <input
                          id="phone"
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel"
                          dir="ltr"
                          required
                          maxLength={30}
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          aria-invalid={detailErrors.phone ? true : undefined}
                          aria-describedby={cn("phone-hint", detailErrors.phone && "phone-error")}
                          className={cn(fieldClass, "text-start")}
                        />
                      </Field>
                      <Field
                        id="email"
                        label={t("email")}
                        error={detailErrors.email ? t("fieldErrors.email") : undefined}
                      >
                        <input
                          id="email"
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          dir="ltr"
                          maxLength={200}
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          aria-invalid={detailErrors.email ? true : undefined}
                          aria-describedby={detailErrors.email ? "email-error" : undefined}
                          className={cn(fieldClass, "text-start")}
                        />
                      </Field>
                    </div>
                  ) : null}

                  {key === "confirm" ? (
                    <div className="flex flex-col gap-4">
                      <h4 className="font-heading text-sm font-medium text-ink">{t("summaryTitle")}</h4>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl bg-saffron-soft p-3 text-sm">
                        <dt className="text-muted-foreground">{t("summaryService")}</dt>
                        <dd className="font-medium">{summaries.service}</dd>
                        <dt className="text-muted-foreground">{t("summaryProvider")}</dt>
                        <dd className="font-medium">
                          {chosenProvider ? pick(loc, chosenProvider.name_ar, chosenProvider.name_en) : ""}
                        </dd>
                        <dt className="text-muted-foreground">{t("summaryWhen")}</dt>
                        <dd className="font-medium">
                          {dateKey ? formatGregorian(dateKey, loc) : ""}
                          {chosenSlot ? ` - ${formatTime(chosenSlot.start, timezone, loc)}` : ""}
                          <span className="block text-xs font-normal text-muted-foreground">
                            {t("hijriLabel")} {dateKey ? formatHijri(dateKey, undefined, loc) : ""}
                          </span>
                        </dd>
                        <dt className="text-muted-foreground">{t("summaryPrice")}</dt>
                        <dd className="font-medium">{service ? formatMoney(service.price, currency, loc) : ""}</dd>
                        <dt className="text-muted-foreground">{t("summaryContact")}</dt>
                        <dd className="font-medium" dir="auto">
                          {fullName.trim()} / <bdi>{phone.trim()}</bdi>
                        </dd>
                      </dl>
                      {depositEnabled ? (
                        <p className="text-sm text-ink">{t("depositWarning")}</p>
                      ) : null}
                      {showError ? (
                        <div
                          role="alert"
                          className="flex gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-ink"
                        >
                          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                          <div className="flex flex-col items-start gap-2">
                            <p className="font-medium">{t("errorTitle")}</p>
                            <p>{t(`errors.${errorCode}`)}</p>
                            {errorCode === "slot_taken" ? (
                              <Button type="button" variant="outline" size="sm" onClick={() => void goToTime()}>
                                {t("pickAnotherTime")}
                              </Button>
                            ) : null}
                            {errorCode === "not_found" ? (
                              <Button type="button" variant="outline" size="sm" onClick={() => goTo(0)}>
                                {t("steps.service")}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="mt-5 flex flex-wrap items-center gap-2">
                    {key === "confirm" ? (
                      <Button
                        type="submit"
                        size="lg"
                        disabled={pending}
                        className="bg-saffron text-ink hover:bg-saffron/85"
                      >
                        {pending ? (
                          <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
                        ) : (
                          <CalendarCheck aria-hidden />
                        )}
                        {pending ? t("submitting") : t("submit")}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="lg"
                        disabled={
                          (key === "service" && !serviceId) ||
                          (key === "time" && !slotStart)
                        }
                        onClick={() => {
                          if (key === "service") goTo(1);
                          else if (key === "provider") void goToTime();
                          else if (key === "time") goTo(3);
                          else if (key === "details" && validateDetails()) goTo(4);
                        }}
                      >
                        {t("continue")}
                      </Button>
                    )}
                    {i > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="lg"
                        onClick={() => goTo(i - 1)}
                      >
                        {t("back")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </form>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
