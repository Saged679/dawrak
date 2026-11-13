import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";

/** Banner for items of a demo business that the database keeps read-only for visitors. */
export function DemoLockedBanner({ className = "" }: { className?: string }) {
  const t = useTranslations("Manage.demoLocked");
  return (
    <div
      role="note"
      data-testid="demo-locked"
      className={`flex items-start gap-2 rounded-xl bg-saffron-soft px-4 py-3 text-[#6b3f00] ${className}`}
    >
      <Lock className="mt-1 size-4 shrink-0" aria-hidden />
      <p>
        <strong className="font-semibold">{t("title")}.</strong> {t("text")}
      </p>
    </div>
  );
}
