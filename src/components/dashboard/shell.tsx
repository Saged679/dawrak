import { Globe, Scissors, Stethoscope } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Logo } from "@/components/brand/logo";
import { Link } from "@/i18n/navigation";
import { navFor } from "@/lib/auth/roles";
import type { SessionContext } from "@/lib/auth/session";
import { NavLinks } from "./nav-links";
import { UserMenu } from "./user-menu";

const mainSiteClass =
  "inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium text-cobalt-deep underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export async function DashboardShell({
  session,
  locale,
  children,
}: {
  session: SessionContext;
  locale: string;
  children: React.ReactNode;
}) {
  const t = await getTranslations("Dash");
  const items = navFor(session.role).map((i) => ({
    key: i.key,
    href: i.href,
    // A provider's "Providers" entry opens only their own schedule.
    label: t(i.key === "providers" && session.role === "provider" ? "nav.mySchedule" : `nav.${i.key}`),
  }));
  const tenantName =
    locale === "en" ? session.tenant.name_en || session.tenant.name_ar : session.tenant.name_ar;
  const KindIcon = session.tenant.kind === "salon" ? Scissors : Stethoscope;

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-paper focus:px-3 focus:py-2 focus:text-cobalt focus-visible:outline-2 focus-visible:outline-ring"
      >
        {t("skip")}
      </a>

      <aside className="hidden border-e border-line bg-paper lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:gap-6 lg:p-4">
        <div className="px-2 pt-2">
          <Logo href="/dashboard" size={36} className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
        </div>
        <NavLinks items={items} label={t("navLabel")} variant="rail" />
        <Link href="/" className={`${mainSiteClass} mt-auto`}>
          <Globe className="size-4" aria-hidden />
          {t("mainSite")}
        </Link>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="m-topbar sticky top-0 z-30 bg-cobalt text-white">
          <div className="flex min-h-16 items-center gap-3 px-4 sm:px-6">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Logo
                href="/dashboard"
                size={36}
                tone="mono-light"
                showWordmark={false}
                label={t("brand")}
                className="shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white lg:hidden"
              />
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 font-heading text-base font-semibold leading-tight">
                  <KindIcon className="size-4 shrink-0 text-saffron" aria-hidden />
                  <span className="truncate" data-testid="tenant-name">
                    {tenantName}
                  </span>
                </p>
                <p className="truncate text-xs text-white">
                  {t(`kind.${session.tenant.kind}`)} · {t(`roles.${session.role}`)}
                  {session.tenant.is_demo ? ` · ${t("demoBadge")}` : ""}
                </p>
              </div>
            </div>
            <UserMenu session={session} locale={locale} />
          </div>
        </header>
        <div className="border-b border-line bg-paper lg:hidden">
          <NavLinks items={items} label={t("navLabel")} variant="tabs" />
        </div>
        <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6" tabIndex={-1}>
          {children}
        </main>
        <footer className="border-t border-line px-4 py-2 sm:px-6 lg:hidden">
          <Link href="/" className={mainSiteClass}>
            <Globe className="size-4" aria-hidden />
            {t("mainSite")}
          </Link>
        </footer>
      </div>
    </div>
  );
}
