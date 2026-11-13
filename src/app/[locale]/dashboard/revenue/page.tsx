import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { formatGregorian, formatMoney, formatNumber, type Loc } from "@/components/booking/dates";
import { routing } from "@/i18n/routing";
import { requireRole } from "@/lib/auth/session";
import { loadRevenue } from "@/lib/dashboard/queries";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Revenue" });
  return { title: t("metaTitle") };
}

export default async function RevenuePage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const loc = locale as Loc;
  // Server-side gate: only the owner. Everyone else is sent back to the overview.
  const session = await requireRole(locale, ["owner"]);
  const [t, data] = await Promise.all([getTranslations("Revenue"), loadRevenue(session)]);
  const cur = session.tenant.currency;
  const days = data.days.filter((d) => d.count > 0);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{t("title")}</h1>
        <p className="text-muted-foreground">{t("lead")}</p>
      </header>
      <dl className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-saffron-soft p-4">
          <dt className="text-sm text-[#6b3f00]">{t("total")}</dt>
          <dd className="font-heading text-3xl font-semibold tabular-nums" data-testid="revenue-total">
            {formatMoney(data.total, cur, loc)}
          </dd>
        </div>
        <div className="rounded-2xl border border-line bg-paper p-4">
          <dt className="text-sm text-muted-foreground">{t("payments")}</dt>
          <dd className="font-heading text-3xl font-semibold tabular-nums">{formatNumber(data.count, loc)}</dd>
        </div>
      </dl>
      {days.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-4 text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-paper">
          <table className="w-full text-start">
            <thead className="bg-mist text-sm text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 text-start font-medium">{t("day")}</th>
                <th scope="col" className="px-4 py-2 text-end font-medium">{t("amount")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {days.map((d) => (
                <tr key={d.dateKey}>
                  <td className="px-4 py-2">
                    {formatGregorian(d.dateKey, loc, { weekday: "short", day: "numeric", month: "short" })}
                  </td>
                  <td className="px-4 py-2 text-end tabular-nums">{formatMoney(d.total, cur, loc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
