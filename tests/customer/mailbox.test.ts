import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; session_hash: string; subject: string; to_email: string; body_text: string; created_at: string };
const rows = vi.hoisted(() => ({ v: [] as Row[] }));
const queries = vi.hoisted(() => ({ v: 0 }));
const cookieJar = vi.hoisted(() => ({ store: new Map<string, string>(), set: vi.fn() }));

vi.mock("@/lib/db/client", () => ({
  getServiceClient: () => ({
    from: () => {
      queries.v++;
      let filtered = rows.v;
      const q = {
        select: () => q,
        eq: (col: string, val: string) => {
          filtered = filtered.filter((r) => (r as unknown as Record<string, string>)[col] === val);
          return q;
        },
        order: () => {
          filtered = [...filtered].sort((a, b) => b.created_at.localeCompare(a.created_at));
          return q;
        },
        limit: async (n: number) => ({ data: filtered.slice(0, n), error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.store.has(n) ? { name: n, value: cookieJar.store.get(n) } : undefined),
    set: (n: string, v: string, o: unknown) => {
      cookieJar.store.set(n, v);
      cookieJar.set(n, v, o);
    },
  }),
}));

import { listMailbox } from "@/lib/demo/mailbox";
import { linkPartsFor } from "@/lib/demo/links";
import { DEMO_SESSION_COOKIE, ensureDemoSessionHash, hashDemoSession, readDemoSessionHash } from "@/lib/demo/session";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const A = sha("visitor-a");
const B = sha("visitor-b");
const mk = (id: string, hash: string, at: string): Row => ({
  id, session_hash: hash, subject: `s-${id}`, to_email: "x@y.z", body_text: `body-${id}`, created_at: at,
});

describe("per-session mailbox isolation", () => {
  beforeEach(() => {
    queries.v = 0;
    cookieJar.store.clear();
    cookieJar.set.mockClear();
    rows.v = [mk("1", A, "2030-01-01T10:00:00Z"), mk("2", B, "2030-01-01T11:00:00Z"), mk("3", A, "2030-01-01T12:00:00Z")];
  });

  it("a visitor sees only their own mails, newest first", async () => {
    expect((await listMailbox(A)).map((m) => m.id)).toEqual(["3", "1"]);
    expect((await listMailbox(B)).map((m) => m.id)).toEqual(["2"]);
  });

  it("a hash that matches nothing, or a malformed one, yields an empty box (and the latter does not even query)", async () => {
    expect(await listMailbox(sha("someone-else"))).toEqual([]);
    queries.v = 0;
    for (const bad of ["", "abc", "%", "a' or '1'='1", A.toUpperCase(), `${A}0`]) expect(await listMailbox(bad)).toEqual([]);
    expect(queries.v).toBe(0);
  });

  it("no cookie means no hash, so the page can only show the empty state", async () => {
    expect(await readDemoSessionHash()).toBeNull();
  });

  it("the cookie value is hashed: the page asks the database for the hash, never the raw cookie", async () => {
    const raw = "R".repeat(43);
    cookieJar.store.set(DEMO_SESSION_COOKIE, raw);
    expect(await readDemoSessionHash()).toBe(sha(raw));
    expect(hashDemoSession(raw)).not.toContain(raw);
  });

  it("a forged or malformed cookie is ignored", async () => {
    for (const v of ["", "short", "x".repeat(44), "x'; drop table demo_outbox;--".padEnd(43, "x"), `${"R".repeat(42)}!`]) {
      cookieJar.store.set(DEMO_SESSION_COOKIE, v);
      expect(await readDemoSessionHash(), v).toBeNull();
    }
  });

  it("ensureDemoSessionHash creates a random httpOnly cookie once and reuses it", async () => {
    const h1 = await ensureDemoSessionHash();
    expect(cookieJar.set).toHaveBeenCalledTimes(1);
    const [name, value, opts] = cookieJar.set.mock.calls[0];
    expect(name).toBe(DEMO_SESSION_COOKIE);
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(h1).toBe(sha(value));
    expect(await ensureDemoSessionHash()).toBe(h1);
    expect(cookieJar.set).toHaveBeenCalledTimes(1);
    // two visitors never share a session
    cookieJar.store.clear();
    expect(await ensureDemoSessionHash()).not.toBe(h1);
  });
});

describe("mail text links", () => {
  it("links only our own origin; foreign URLs stay inert text", () => {
    const parts = linkPartsFor("Open https://app.test/en/c/a/my/tok now, not https://evil.test/x or javascript:alert(1)", "https://app.test");
    expect(parts.filter((p) => p.href).map((p) => p.href)).toEqual(["https://app.test/en/c/a/my/tok"]);
    expect(parts.map((p) => p.text).join("")).toBe("Open https://app.test/en/c/a/my/tok now, not https://evil.test/x or javascript:alert(1)");
    expect(linkPartsFor("https://app.test.evil.com/x", "https://app.test").some((p) => p.href)).toBe(false);
  });
});
