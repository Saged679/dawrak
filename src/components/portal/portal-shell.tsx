import type { CSSProperties, ReactNode } from "react";
import { Link } from "@/i18n/navigation";
import { brandStyleVars } from "@/lib/db/brand";
import type { Loc } from "@/components/booking/dates";

/** Header + main column shared by the patient page and the "send me a link" page. */
export function PortalShell({
  slug,
  name,
  brandColor,
  locale,
  backLabel,
  children,
}: {
  slug: string;
  name: string;
  brandColor: string | null | undefined;
  locale: Loc;
  backLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="contents" style={brandStyleVars(brandColor) as CSSProperties}>
      <header className="bg-cobalt text-(--brand-fg)">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3 px-4 py-5 sm:px-6">
          <p className="min-w-0 break-words font-heading text-xl font-semibold">{name}</p>
          <Link
            href={`/c/${slug}`}
            locale={locale}
            className="shrink-0 rounded-md px-2 py-2 text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-fg)"
          >
            {backLabel}
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full min-w-0 max-w-2xl flex-1 px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
