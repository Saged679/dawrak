import type { MetadataRoute } from "next";
import { buildSitemap } from "@/lib/seo/sitemap";
import { siteUrl } from "@/lib/seo/site";
import { listSitemapTenants } from "@/lib/seo/tenants";

// Reads the tenant list per request (no DB is needed or available at build time).
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let tenants: Awaited<ReturnType<typeof listSitemapTenants>> = [];
  try {
    tenants = await listSitemapTenants();
  } catch (e) {
    // A crawler should still get the landing pages if the database is down.
    console.error("sitemap: could not list tenants", e instanceof Error ? e.message : e);
  }
  return buildSitemap(siteUrl(), tenants);
}
