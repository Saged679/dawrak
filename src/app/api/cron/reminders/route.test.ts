import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());
const rateLimitOk = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reminders/dispatch", () => ({ dispatchDueReminders: (...a: unknown[]) => dispatch(...a) }));
vi.mock("@/lib/reminders/store", () => ({ supabaseReminderStore: () => ({}) }));
vi.mock("@/lib/db/client", () => ({ getServiceClient: () => ({ rpc }) }));
vi.mock("@/lib/db/public", () => ({ rateLimitOk: (...a: unknown[]) => rateLimitOk(...a) }));
const reembed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent/reembed", () => ({ reembedMissing: (...a: unknown[]) => reembed(...a) }));
vi.mock("@/lib/mail", () => ({ mailProviderFor: vi.fn() }));
vi.mock("@/lib/mail/links", () => ({ manageUrl: vi.fn() }));

import { GET, POST } from "./route";
import type { NextRequest } from "next/server";

const SECRET = "dawrak-test-cron-secret-0123456789";
const req = (auth?: string) =>
  new Request("http://localhost/api/cron/reminders", { method: "POST", headers: auth ? { authorization: auth } : {} }) as unknown as NextRequest;

describe("/api/cron/reminders", () => {
  beforeEach(() => {
    dispatch.mockReset().mockResolvedValue({ claimed: 1, sent: 1, retried: 0, failed: 0, skipped: 0 });
    rpc.mockReset().mockResolvedValue({ error: null });
    reembed.mockReset().mockResolvedValue({ embedded: 0, skipped: "no_key" });
    rateLimitOk.mockReset().mockResolvedValue(true);
    vi.stubEnv("CRON_SECRET", SECRET);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("401 without the header, with a wrong secret or the wrong scheme, and does NO work", async () => {
    for (const auth of [undefined, "Bearer wrong", `Basic ${SECRET}`, SECRET, `Bearer ${SECRET}x`]) {
      const res = await POST(req(auth));
      expect(res.status, String(auth)).toBe(401);
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is unset or too short", async () => {
    for (const v of ["", "short"]) {
      vi.stubEnv("CRON_SECRET", v);
      expect((await POST(req(`Bearer ${v}`))).status).toBe(401);
      expect((await POST(req("Bearer undefined"))).status).toBe(401);
    }
    vi.unstubAllEnvs();
    delete process.env.CRON_SECRET;
    expect((await POST(req("Bearer undefined"))).status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("repeated failures are rate limited (429) but still never run the dispatcher", async () => {
    rateLimitOk.mockResolvedValue(false);
    expect((await POST(req("Bearer nope"))).status).toBe(429);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("a limiter outage does not turn a bad secret into anything but 401", async () => {
    rateLimitOk.mockRejectedValue(new Error("db down"));
    expect((await POST(req("Bearer nope"))).status).toBe(401);
  });

  it("200 with the right secret (POST for GitHub Actions, GET for Vercel cron), and runs the dispatcher", async () => {
    const res = await POST(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, claimed: 1, sent: 1, retried: 0, failed: 0, skipped: 0, reembed: { embedded: 0, skipped: "no_key" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("expire_pending_bookings");
    expect(rpc).toHaveBeenCalledWith("purge_demo_outbox");
  });

  it("the background re-embedding step reports its outcome and can never fail the cron", async () => {
    reembed.mockResolvedValue({ embedded: 24 });
    expect(await (await POST(req(`Bearer ${SECRET}`))).json()).toMatchObject({ ok: true, reembed: { embedded: 24 } });
    reembed.mockResolvedValue({ embedded: 0, skipped: "quota" });
    expect(await (await POST(req(`Bearer ${SECRET}`))).json()).toMatchObject({ ok: true, reembed: { skipped: "quota" } });
    reembed.mockRejectedValue(new Error("boom secret"));
    const res = await POST(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });

  it("500 without details when the dispatcher throws", async () => {
    dispatch.mockRejectedValue(new Error("secret-ish detail"));
    const res = await POST(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret-ish");
  });
});
