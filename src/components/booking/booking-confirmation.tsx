"use client";

import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CheckCircle2, Hourglass } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PublicService } from "@/lib/db/public";
import type { BookingResult } from "@/lib/db/schema";
import {
  dateKeyInZone,
  formatGregorian,
  formatHijri,
  formatMoney,
  formatTime,
  type Loc,
} from "./dates";

type Props = {
  booking: BookingResult;
  tenantName: string;
  service: PublicService;
  providerName: string;
  timezone: string;
  onReset: () => void;
};

export function BookingConfirmation({
  booking,
  tenantName,
  service,
  providerName,
  timezone,
  onReset,
}: Props) {
  const t = useTranslations("Booking.confirmation");
  const loc = useLocale() as Loc;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const pending = booking.status === "pending_payment";
  const dateKey = dateKeyInZone(booking.startsAt, timezone);
  const serviceName = loc === "en" ? service.name_en || service.name_ar : service.name_ar;

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section
      aria-labelledby="confirmation-title"
      data-testid="booking-confirmation"
      className="rounded-2xl border border-line bg-paper p-4 shadow-sm sm:p-6"
    >
      <div className="flex items-start gap-3">
        {pending ? (
          <Hourglass className="mt-1 size-6 shrink-0 text-cobalt-deep" aria-hidden />
        ) : (
          <CheckCircle2 className="mt-1 size-6 shrink-0 text-cobalt" aria-hidden />
        )}
        <div>
          <h2
            id="confirmation-title"
            ref={headingRef}
            tabIndex={-1}
            className="font-heading text-xl font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {pending ? t("titlePending") : t("titleConfirmed")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {pending ? t("leadPending") : t("leadConfirmed", { service: serviceName, clinic: tenantName })}
          </p>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl border border-[#EBC88A] bg-saffron-soft p-4 text-sm">
        <dt className="text-muted-foreground">{t("service")}</dt>
        <dd className="font-medium">{serviceName}</dd>
        {providerName ? (
          <>
            <dt className="text-muted-foreground">{t("provider")}</dt>
            <dd className="font-medium">{providerName}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("when")}</dt>
        <dd className="font-medium">
          {formatGregorian(dateKey, loc)} - {formatTime(booking.startsAt, timezone, loc)}
          <span className="block text-xs font-normal text-muted-foreground">
            {formatHijri(dateKey, undefined, loc)}
          </span>
        </dd>
        <dt className="text-muted-foreground">{t("price")}</dt>
        <dd className="font-medium">{formatMoney(booking.price, booking.currency, loc)}</dd>
        {pending ? (
          <>
            <dt className="text-muted-foreground">{t("deposit")}</dt>
            <dd className="font-medium">{formatMoney(booking.depositAmount, booking.currency, loc)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("ref")}</dt>
        <dd className="font-mono text-xs" dir="ltr">
          {booking.appointmentId.slice(0, 8).toUpperCase()}
        </dd>
      </dl>

      {pending ? (
        <div
          role="note"
          data-testid="payment-placeholder"
          className="mt-4 rounded-xl border border-dashed border-cobalt bg-sky/60 p-4"
        >
          <p className="font-heading text-sm font-semibold text-cobalt-deep">{t("paymentTitle")}</p>
          <p className="mt-1 text-sm text-ink">{t("paymentBody")}</p>
        </div>
      ) : null}

      <p className="mt-4 text-sm text-muted-foreground">{t("contactNote")}</p>

      <Button type="button" variant="outline" size="lg" className="mt-4" onClick={onReset}>
        {t("bookAnother")}
      </Button>
    </section>
  );
}
