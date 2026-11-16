import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { LogoMark } from "./logo";

/**
 * Small "Powered by Dawrak" footer for tenant-branded pages (clinic page, customer portal, payment).
 * The tenant's own branding stays primary; this only gives visitors a way to the product site.
 */
export async function PoweredBy({ className = "" }: { className?: string }) {
  const t = await getTranslations("Brand");
  return (
    <footer className={`border-t border-line ${className}`}>
      <div className="mx-auto flex w-full max-w-6xl justify-center px-4 py-3 sm:px-6">
        <Link
          href="/"
          data-testid="powered-by"
          className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground underline-offset-4 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <LogoMark size={18} />
          {t("poweredBy")}
        </Link>
      </div>
    </footer>
  );
}
