// Edge-cheap "does this clinic slug exist" check for the proxy, so an unknown slug gets the server-rendered 404
// (a notFound() thrown inside the page yields Next's empty client-rendered error shell). Uses the anon key: the
// public_get_tenant RPC is granted to anon. Fails open (true) on any error so an outage never 404s a real clinic.
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TTL_MS = 60_000;
const found = new Map<string, number>(); // slug -> expiry; only positives are cached

export async function tenantSlugExists(slug: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (slug.length > 60 || !SLUG_RE.test(slug)) return false;
  const hit = found.get(slug);
  if (hit && hit > Date.now()) return true;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return true;
  try {
    const res = await fetchImpl(`${url}/rest/v1/rpc/public_get_tenant`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_slug: slug }),
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (!res.ok) return true;
    const rows = (await res.json()) as unknown;
    const exists = Array.isArray(rows) && rows.length > 0;
    if (exists) {
      if (found.size > 500) found.clear();
      found.set(slug, Date.now() + TTL_MS);
    }
    return exists;
  } catch {
    return true;
  }
}

/** Test hook. */
export function clearTenantSlugCache() {
  found.clear();
}
