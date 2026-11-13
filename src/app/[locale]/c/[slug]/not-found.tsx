import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export default async function ClinicNotFound() {
  const t = await getTranslations("NotFound");
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-start justify-center gap-4 px-6 py-16">
      <h1 className="font-heading text-3xl font-semibold text-ink">{t("title")}</h1>
      <p className="max-w-[40em] text-lg text-muted-foreground">{t("body")}</p>
      <Link
        href="/"
        className="rounded-md px-3 py-2 text-cobalt underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {t("home")}
      </Link>
    </main>
  );
}
