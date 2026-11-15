import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Search } from "lucide-react";
import {
  dateKeyInZone,
  formatGregorian,
  formatNumber,
  type Loc,
} from "@/components/booking/dates";
import { inputClass, primaryBtn, quietBtn } from "@/components/dashboard/manage/form-classes";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { requireSession } from "@/lib/auth/session";
import { CUSTOMER_PAGE_SIZE, listCustomers } from "@/lib/dashboard/catalog";
import { cleanSearch } from "@/lib/dashboard/manage";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Customers" });
  return { title: t("metaTitle") };
}

export default async function CustomersPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const loc = locale as Loc;
  const sp = await searchParams;
  const q = cleanSearch(Array.isArray(sp.q) ? sp.q[0] : sp.q);
  // All three roles may open this page; what they see is decided by RLS (a provider only gets
  // customers on their own appointments) and listCustomers filters its stats the same way.
  const session = await requireSession(locale);
  const [t, { items, truncated }] = await Promise.all([
    getTranslations("Customers"),
    listCustomers(session, q),
  ]);
  const tz = session.tenant.timezone;
  const day = (iso: string) =>
    formatGregorian(dateKeyInZone(iso, tz), loc, { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{t("title")}</h1>
        <p className="text-muted-foreground">
          {session.role === "provider" ? t("leadProvider") : t("lead")}
        </p>
      </header>

      <form role="search" method="get" className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1.5">
          <label htmlFor="q" className="text-sm font-medium">
            {t("searchLabel")}
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={q}
            maxLength={60}
            placeholder={t("searchPlaceholder")}
            className={inputClass}
            data-testid="customer-search"
          />
        </div>
        <button type="submit" className={primaryBtn}>
          <Search className="size-4" aria-hidden />
          {t("search")}
        </button>
        {q ? (
          <Link href="/dashboard/customers" className={quietBtn}>
            {t("clear")}
          </Link>
        ) : null}
      </form>

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-4 text-muted-foreground" data-testid="customers-empty">
          {q ? t("emptySearch") : t("empty")}
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-3" data-testid="customer-list">
            {items.map((c) => (
              <li key={c.id} data-testid={`customer-${c.id}`}>
                <Link
                  href={`/dashboard/customers/${c.id}`}
                  className="flex flex-col gap-2 rounded-2xl border border-line bg-paper p-4 outline-none hover:bg-sky/40 focus-visible:ring-3 focus-visible:ring-ring/60"
                >
                  <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="font-heading text-lg font-semibold">{c.full_name}</span>
                    <span dir="ltr" className="text-sm text-muted-foreground tabular-nums">
                      {c.phone}
                    </span>
                  </span>
                  {c.email ? (
                    <span dir="ltr" className="break-all text-sm text-muted-foreground">
                      {c.email}
                    </span>
                  ) : null}
                  <dl className="grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">{t("columns.lastVisit")}</dt>
                      <dd>{c.lastVisit ? day(c.lastVisit) : t("never")}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">{t("columns.visits")}</dt>
                      <dd className="tabular-nums">{formatNumber(c.visits, loc)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">{t("columns.noShows")}</dt>
                      <dd className="tabular-nums">{formatNumber(c.noShows, loc)}</dd>
                    </div>
                  </dl>
                </Link>
              </li>
            ))}
          </ul>
          {truncated ? (
            <p className="text-sm text-muted-foreground">{t("truncated", { n: formatNumber(CUSTOMER_PAGE_SIZE, loc) })}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
