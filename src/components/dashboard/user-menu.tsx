import { ChevronDown, LogOut } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { signOut, switchTenant } from "@/lib/auth/actions";
import type { SessionContext } from "@/lib/auth/session";
import { LocaleSwitch } from "./locale-switch";

/** Native <details> menu: keyboard operable with no JS. */
export async function UserMenu({
  session,
  locale,
}: {
  session: SessionContext;
  locale: string;
}) {
  const t = await getTranslations("Dash");
  const name = session.fullName || session.email;
  const others = session.memberships.filter((m) => m.tenant.id !== session.tenant.id);

  return (
    <details className="group relative">
      <summary
        aria-label={t("menu.label")}
        className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full bg-white/15 ps-3 pe-2 text-sm font-medium text-white outline-none hover:bg-white/25 focus-visible:ring-3 focus-visible:ring-saffron [&::-webkit-details-marker]:hidden"
      >
        <span className="max-w-[7rem] truncate sm:max-w-[10rem]">{name}</span>
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="m-menu absolute end-0 z-40 mt-2 w-64 rounded-xl border border-line bg-paper p-2 text-ink shadow-lg">
        <p className="px-3 py-1 text-xs text-muted-foreground">{session.email}</p>
        <p className="px-3 pb-2 text-sm font-medium">{t(`roles.${session.role}`)}</p>
        <div className="border-t border-line pt-1">
          <LocaleSwitch label={t("menu.language")} />
        </div>
        {others.length > 0 ? (
          <div className="border-t border-line pt-1">
            <p className="px-3 py-1 text-xs text-muted-foreground">{t("menu.tenant")}</p>
            {others.map((m) => (
              <form key={m.tenant.id} action={switchTenant}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="tenantId" value={m.tenant.id} />
                <button
                  type="submit"
                  className="w-full rounded-md px-3 py-2 text-start text-sm outline-none hover:bg-mist focus-visible:ring-3 focus-visible:ring-ring/60"
                >
                  {locale === "en" ? m.tenant.name_en || m.tenant.name_ar : m.tenant.name_ar}
                </button>
              </form>
            ))}
          </div>
        ) : null}
        <form action={signOut} className="border-t border-line pt-1">
          <input type="hidden" name="locale" value={locale} />
          <button
            type="submit"
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm font-medium text-destructive outline-none hover:bg-mist focus-visible:ring-3 focus-visible:ring-ring/60"
          >
            <LogOut className="size-4" aria-hidden />
            {t("menu.logout")}
          </button>
        </form>
      </div>
    </details>
  );
}
