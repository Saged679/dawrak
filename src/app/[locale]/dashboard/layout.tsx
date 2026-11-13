import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { DashboardShell } from "@/components/dashboard/shell";
import { requireSession } from "@/lib/auth/session";
import { NOINDEX } from "@/lib/seo/metadata";

// Inherited by every /dashboard/** page (their own metadata sets only the title).
export const metadata: Metadata = NOINDEX;

export default async function DashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireSession(locale);
  return (
    <DashboardShell session={session} locale={locale}>
      {children}
    </DashboardShell>
  );
}
