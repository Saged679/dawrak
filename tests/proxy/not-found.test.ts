import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import proxy from "@/proxy";
import { clearTenantSlugCache, tenantSlugExists } from "@/lib/db/tenant-exists";

const req = (path: string) => new NextRequest(`http://localhost:3100${path}`);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearTenantSlugCache();
});

describe("proxy 404 rewrite carries the path's locale", () => {
  it.each([
    ["/en/nope", "en"],
    ["/ar/nope", "ar"],
    ["/en/no/such/page", "en"],
    ["/ar/login/extra", "ar"],
  ])("%s -> /%s/page-not-found, status 404, locale header", async (path, locale) => {
    const res = await proxy(req(path));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-middleware-rewrite")).toContain(`/${locale}/page-not-found`);
    expect(res.headers.get("x-next-intl-locale")).toBe(locale);
    expect(res.headers.get("x-middleware-request-x-next-intl-locale")).toBe(locale);
  });
});

describe("unknown clinic slug gets the same rendered 404", () => {
  it("rewrites /en/c/<unknown> to the English 404 page", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    const res = await proxy(req("/en/c/zzz-nope"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-middleware-rewrite")).toContain("/en/page-not-found");
  });
  it("lets a known slug through (no rewrite)", async () => {
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
