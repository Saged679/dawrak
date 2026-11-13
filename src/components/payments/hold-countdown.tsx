"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

/**
 * Time left on the 15-minute hold. The deadline and "now" both come from the server; the browser
 * clock is used only to measure elapsed time since the page rendered, so a wrong device clock
 * cannot extend or shorten the hold.
 */
export function HoldCountdown({ expiresAtMs, serverNowMs }: { expiresAtMs: number; serverNowMs: number }) {
  const t = useTranslations("Payment");
  const locale = useLocale();
  const router = useRouter();
  const [renderedAt] = useState(() => Date.now());
  const [left, setLeft] = useState(() => Math.max(0, expiresAtMs - serverNowMs));

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, expiresAtMs - serverNowMs - (Date.now() - renderedAt)));
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [expiresAtMs, serverNowMs, renderedAt]);

  useEffect(() => {
    if (left === 0) router.refresh();
  }, [left, router]);

  const total = Math.ceil(left / 1000);
  const nf = new Intl.NumberFormat(locale === "ar" ? "ar-SA-u-nu-arab" : "en-US", { minimumIntegerDigits: 2 });
  const text = `${nf.format(Math.floor(total / 60))}:${nf.format(total % 60)}`;

  return (
    <div className="rounded-xl border border-line bg-sky/60 p-4" data-testid="hold-countdown">
      <p className="text-sm text-muted-foreground">{t("timeLeft")}</p>
      <p
        className="font-heading text-3xl font-semibold tabular-nums text-cobalt-deep"
        dir="ltr"
        role="timer"
        aria-live="off"
      >
        {left === 0 ? t("timeUp") : text}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{t("timeLeftHint")}</p>
    </div>
  );
}
