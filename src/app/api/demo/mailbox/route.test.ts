import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const listMailbox = vi.hoisted(() => vi.fn());
const fail = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/demo/mailbox", () => ({
  listMailbox: async (...a: unknown[]) => {
    if (fail.on) throw new Error("db down"); // a plain function: vitest 5 flags throwing vi.fn mocks
    return listMailbox(...a);
  },
}));

import { GET } from "./route";
import { hashDemoSession, newDemoSessionValue } from "@/lib/demo/session";

// session.ts imports next/headers (server runtime only), which is harmless to import under vitest
const req = (cookie?: string) =>
  new NextRequest("http://localhost/api/demo/mailbox", { headers: cookie ? { cookie } : {} });

describe("GET /api/demo/mailbox (poll)", () => {
  beforeEach(() => {
    listMailbox.mockReset();
    fail.on = false;
  });

  it("without a session cookie: empty answer, the database is never queried", async () => {
    const res = await GET(req());
    expect(await res.json()).toEqual({ count: 0, ids: [] });
    expect(listMailbox).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("a malformed cookie counts as none", async () => {
    const res = await GET(req("dawrak_demo_session=not-a-valid-value"));
    expect(await res.json()).toEqual({ count: 0, ids: [] });
    expect(listMailbox).not.toHaveBeenCalled();
  });

  it("queries ONLY by the hash of the caller's own cookie and returns ids, nothing else", async () => {
    const raw = newDemoSessionValue();
    listMailbox.mockResolvedValue([
      { id: "m1", subject: "secret subject", to: "a@b.c", body: "link http://x/my/tok", createdAt: "2030-01-01" },
    ]);
    const res = await GET(req(`other=1; dawrak_demo_session=${raw}`));
    expect(listMailbox).toHaveBeenCalledTimes(1);
    expect(listMailbox).toHaveBeenCalledWith(hashDemoSession(raw));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ count: 1, ids: ["m1"] });
    expect(text).not.toMatch(/secret|a@b\.c|tok/);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("two visitors get their own rows (each call is keyed by its own cookie)", async () => {
    const a = newDemoSessionValue();
    const b = newDemoSessionValue();
    listMailbox.mockImplementation(async (h: string) => (h === hashDemoSession(a) ? [{ id: "A" }] : []));
    expect(await (await GET(req(`dawrak_demo_session=${a}`))).json()).toEqual({ count: 1, ids: ["A"] });
    expect(await (await GET(req(`dawrak_demo_session=${b}`))).json()).toEqual({ count: 0, ids: [] });
  });

  it("a database failure is a 503 without details", async () => {
    fail.on = true;
    const res = await GET(req(`dawrak_demo_session=${newDemoSessionValue()}`));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("db down");
  });
});
