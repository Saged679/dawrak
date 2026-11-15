import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import proxy from "@/proxy";
import { clearTenantSlugCache, tenantSlugExists } from "@/lib/db/tenant-exists";

const req = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost:3100${path}`, { headers });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearTenantSlugCache();
});

describe("proxy answers an unknown path with the 404 document itself, in the path's locale", () => {
  it.each([
    ["/en/nope", "en", "ltr", "We couldn&#39;t find this page"],
    ["/ar/nope", "ar", "rtl", "لم نجد هذه الصفحة"],
    ["/en/no/such/page", "en", "ltr", "We couldn&#39;t find this page"],
    ["/ar/login/extra", "ar", "rtl", "لم نجد هذه الصفحة"],
  ])("%s -> status 404, lang=%s dir=%s", async (path, locale, dir, title) => {
    const res = await proxy(req(path));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain(`<html lang="${locale}" dir="${dir}"`);
    expect(html).toContain(`<h1>${title}</h1>`);
    expect(html).toContain(`href="/${locale}"`);
    expect(html).toContain('name="robots" content="noindex"');
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("the locale in the path wins over Accept-Language and NEXT_LOCALE", async () => {
    const res = await proxy(req("/en/nope", { "accept-language": "ar", cookie: "NEXT_LOCALE=ar" }));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<html lang="en" dir="ltr"');
    expect(html).toContain("We couldn&#39;t find this page");
    const ar = await (await proxy(req("/ar/nope", { "accept-language": "en", cookie: "NEXT_LOCALE=en" }))).text();
    expect(ar).toContain('<html lang="ar" dir="rtl"');
  });
});

describe("unknown clinic slug gets the same 404", () => {
  it("answers /en/c/<unknown> with the English 404", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    const res = await proxy(req("/en/c/zzz-nope", { "accept-language": "ar" }));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<html lang="en" dir="ltr"');
  });
  it("lets a known slug through (no 404)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response('[{"id":"x"}]', { status: 200 })));
    const res = await proxy(req("/ar/c/demo-clinic"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-rewrite") ?? "").not.toContain("page-not-found");
  });
  it("fails open when the lookup errors, and rejects malformed slugs without a request", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
    const f = vi.fn(async () => { throw new Error("down"); });
    expect(await tenantSlugExists("some-clinic", f as unknown as typeof fetch)).toBe(true);
    const g = vi.fn();
    expect(await tenantSlugExists("Bad_Slug", g as unknown as typeof fetch)).toBe(false);
    expect(g).not.toHaveBeenCalled();
  });
});
