import "server-only";

export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
}

/** Absolute URL of the patient page. The token is a secret: only ever put this in an e-mail or a redirect. */
export function manageUrl(locale: "ar" | "en", slug: string, token: string): string {
  return `${siteUrl()}/${locale}/c/${slug}/my/${token}`;
}
