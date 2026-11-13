"use client";

import { useTranslations } from "next-intl";
import { StatusView, statusButtonClass, statusLinkClass } from "@/components/status/status-view";
import { Link } from "@/i18n/navigation";

// Never renders error.message / digest / stack: they can hold internals.
export default function LocaleError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations("Errors");
  return (
    <>
      <meta name="robots" content="noindex" />
      <StatusView code="500" title={t("errorTitle")} body={t("errorBody")}>
        <button type="button" onClick={() => retry()} className={statusButtonClass}>
          {t("retry")}
        </button>
        <Link href="/" className={statusLinkClass}>
          {t("home")}
        </Link>
      </StatusView>
    </>
  );
}
