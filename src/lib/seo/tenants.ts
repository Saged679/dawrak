import "server-only";
import { getServiceClient } from "@/lib/db/client";
import type { SitemapTenant } from "./sitemap";

/** Every tenant's public slug. Tenants have no status column yet, so all of them have a public page. */
export async function listSitemapTenants(): Promise<SitemapTenant[]> {
  const { data, error } = await getServiceClient()
    .from("tenants")
    .select("slug, is_demo")
    .order("slug")
    .limit(10000);
  if (error) throw error;
  return (data ?? []) as SitemapTenant[];
}
