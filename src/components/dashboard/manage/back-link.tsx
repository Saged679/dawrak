import { ArrowLeft, ArrowRight } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

/** Back link; the arrow points the reading-direction-correct way. */
export async function BackLink({ href, label }: { href: string; label?: string }) {
  const tm = await getTranslations("Manage");
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 w-fit items-center gap-2 rounded-lg text-sm font-medium text-cobalt-deep outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/60"
    >
      <ArrowRight className="size-4 ltr:hidden" aria-hidden />
      <ArrowLeft className="size-4 rtl:hidden" aria-hidden />
      {label ?? tm("back")}
    </Link>
  );
}
