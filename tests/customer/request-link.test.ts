import { beforeEach, describe, expect, it, vi } from "vitest";

const sendLinkEmail = vi.hoisted(() => vi.fn());
const rateLimitOk = vi.hoisted(() => vi.fn());
const getTenantBySlug = vi.hoisted(() => vi.fn());
const ensureDemoSessionHash = vi.hoisted(() => vi.fn());
const afterCbs = vi.hoisted(() => ({ v: [] as (() => Promise<void> | void)[] }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`REDIRECT:${to}`), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  },
  notFound: () => {
    throw Object.assign(new Error("NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({ after: (cb: () => Promise<void> | void) => void afterCbs.v.push(cb) }));
vi.mock("@/lib/customer/emails", () => ({ sendLinkEmail: (...a: unknown[]) => sendLinkEmail(...a) }));
vi.mock("@/lib/customer/portal", () => ({ loadPortal: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getServiceClient: () => ({ rpc: vi.fn() }) }));
vi.mock("@/lib/db/public", () => ({
  rateLimitOk: (...a: unknown[]) => rateLimitOk(...a),
  getTenantBySlug: (...a: unknown[]) => getTenantBySlug(...a),
}));
vi.mock("@/lib/demo/session", () => ({ ensureDemoSessionHash: (...a: unknown[]) => ensureDemoSessionHash(...a) }));

import { requestLink } from "@/app/[locale]/c/[slug]/my/actions";

const form = (contact: string, slug = "clinic-a", locale = "en") => {
  const fd = new FormData();
  fd.set("slug", slug);
  fd.set("locale", locale);
  fd.set("contact", contact);
  return fd;
};
const redirected = async (fd: FormData) => {
  try {
    await requestLink(fd);
  } catch (e) {
    const m = /REDIRECT:(.*)$/.exec((e as Error).message);
    if (m) return m[1];
    throw e;
  }
  return "no-redirect";
};
const flush = async () => {
  for (const cb of afterCbs.v.splice(0)) await cb();
};

describe("requestLink (neutral response)", () => {
  beforeEach(() => {
    sendLinkEmail.mockReset();
    rateLimitOk.mockReset().mockResolvedValue(true);
    ensureDemoSessionHash.mockReset().mockResolvedValue("c".repeat(64));
    getTenantBySlug.mockReset().mockResolvedValue({ id: "t1", slug: "clinic-a", is_demo: false, name_ar: "ع", name_en: "A" });
    afterCbs.v = [];
  });

  it("gives the identical answer whether or not a customer exists, and even if sending blows up", async () => {
    sendLinkEmail.mockResolvedValueOnce(undefined); // customer exists, mail sent
    const a = await redirected(form("0501234567"));
    await flush();
    sendLinkEmail.mockResolvedValueOnce(undefined); // nobody matches (sendLinkEmail returns silently)
    const b = await redirected(form("0509999999"));
    await flush();
    sendLinkEmail.mockRejectedValueOnce(new Error("smtp down"));
    const c = await redirected(form("0508888888"));
    await expect(flush()).resolves.toBeUndefined();
    expect([a, b, c]).toEqual(["/en/c/clinic-a/my?sent=1", "/en/c/clinic-a/my?sent=1", "/en/c/clinic-a/my?sent=1"]);
  });

  it("does the lookup after the response (nothing is awaited before the redirect)", async () => {
    sendLinkEmail.mockImplementation(() => new Promise(() => {})); // never settles
    expect(await redirected(form("0501234567"))).toBe("/en/c/clinic-a/my?sent=1");
    expect(sendLinkEmail).not.toHaveBeenCalled(); // only queued
    expect(afterCbs.v).toHaveLength(1);
  });

  it("normalises a phone, lower-cases an e-mail, and passes only one of them", async () => {
    await redirected(form("050 123 4567"));
    await redirected(form("Sara@Example.COM"));
    await flush();
    expect(sendLinkEmail.mock.calls[0][0]).toMatchObject({ phone: "+966501234567", email: null });
    expect(sendLinkEmail.mock.calls[1][0]).toMatchObject({ phone: null, email: "sara@example.com" });
  });

  it("is rate limited per IP and per contact, with keys that hold no raw contact data", async () => {
    await redirected(form("0501234567"));
    const keys = rateLimitOk.mock.calls.map((c) => String(c[0]));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^ip:[0-9a-f]{32}:mylink$/);
    expect(keys[1]).toMatch(/^contact:[0-9a-f]{32}:mylink$/);
    expect(keys.join("|")).not.toMatch(/0501234567|966501234567/);
  });

  it("when a limit is hit nothing is queued, and the answer does not depend on the customer", async () => {
    rateLimitOk.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await redirected(form("0501234567"))).toBe("/en/c/clinic-a/my?error=rate_limited");
    expect(afterCbs.v).toHaveLength(0);
    rateLimitOk.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await redirected(form("0500000000"))).toBe("/en/c/clinic-a/my?error=rate_limited");
  });

  it("rejects garbage input before any limit or lookup is used", async () => {
    for (const bad of ["abc", "12345", "not an email@", "a@b", "x".repeat(300)]) {
      expect(await redirected(form(bad)), bad).toBe("/en/c/clinic-a/my?error=invalid");
    }
    expect(rateLimitOk).not.toHaveBeenCalled();
    expect(sendLinkEmail).not.toHaveBeenCalled();
  });

  it("gives a demo visitor a session (mailbox) for every request, and real tenants none", async () => {
    getTenantBySlug.mockResolvedValue({ id: "t9", slug: "demo", is_demo: true, name_ar: "ع", name_en: "D" });
    await redirected(form("0501234567", "demo"));
    await flush();
    expect(ensureDemoSessionHash).toHaveBeenCalledTimes(1);
    expect(sendLinkEmail.mock.calls[0][0]).toMatchObject({ sessionHash: "c".repeat(64) });

    ensureDemoSessionHash.mockClear();
    getTenantBySlug.mockResolvedValue({ id: "t1", slug: "clinic-a", is_demo: false, name_ar: "ع", name_en: "A" });
    await redirected(form("0501234567"));
    expect(ensureDemoSessionHash).not.toHaveBeenCalled();
  });

  it("an unknown clinic is a 404, not a hint about customers", async () => {
    getTenantBySlug.mockResolvedValue(null);
    await expect(requestLink(form("0501234567", "nope"))).rejects.toThrow("NOT_FOUND");
  });
});
