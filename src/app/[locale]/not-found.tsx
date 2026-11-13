import { getTranslations } from "next-intl/server";
import { StatusView, statusButtonClass } from "@/components/status/status-view";
import { Link } from "@/i18n/navigation";

// Next adds `<meta name="robots" content="noindex">` and keeps the 404 status for not-found.
export default async function LocaleNotFound() {
  const t = await getTranslations("Errors");
  return (
    <StatusView code="404" title={t("notFoundTitle")} body={t("notFoundBody")}>
      <Link href="/" className={statusButtonClass}>
        {t("home")}
      </Link>
    </StatusView>
  );
}
