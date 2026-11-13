"use client";

import { useLocale } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, usePathname } from "@/i18n/navigation";

/** Same page, other language; keeps the query string (calendar date, view). */
export function LocaleSwitch({ label }: { label: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const locale = useLocale();
  const qs = search.toString();
  const other = locale === "ar" ? "en" : "ar";
  return (
    <Link
      href={(qs ? `${pathname}?${qs}` : pathname) as "/"}
      locale={other}
      lang={other}
      className="block rounded-md px-3 py-2 text-sm font-medium outline-none hover:bg-mist focus-visible:ring-3 focus-visible:ring-ring/60"
    >
      {label}
    </Link>
  );
}
