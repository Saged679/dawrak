import type { Metadata } from "next";
import { IBM_Plex_Sans_Arabic, Readex_Pro } from "next/font/google";
import Link from "next/link";
import ar from "../../messages/ar.json";
import { localeDir } from "@/i18n/routing";
import { StatusView, statusButtonClass } from "@/components/status/status-view";
import "./globals.css";

// Paths no route matches at all (outside the locale tree). No request locale is available here,
// so the default language (Arabic, RTL) is used with a link to the English site.
const readex = Readex_Pro({ variable: "--font-readex", subsets: ["arabic", "latin"], display: "swap" });
const plexArabic = IBM_Plex_Sans_Arabic({
  variable: "--font-plex-arabic",
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = { title: ar.Errors.notFoundTitle }; // Next adds robots noindex itself

export default function GlobalNotFound() {
  return (
    <html lang="ar" dir={localeDir.ar} className={`${readex.variable} ${plexArabic.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <StatusView code="404" title={ar.Errors.notFoundTitle} body={ar.Errors.notFoundBody}>
          <Link href="/ar" className={statusButtonClass}>
            {ar.Errors.home}
          </Link>
          <Link href="/en" lang="en" className="font-medium text-cobalt underline underline-offset-4">
            English
          </Link>
        </StatusView>
      </body>
    </html>
  );
}
