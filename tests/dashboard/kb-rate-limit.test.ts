import { beforeEach, describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

const state = vi.hoisted(() => ({
  session: null as unknown,
  hits: [] as { key: string; max: number; window: string }[],
  deny: null as string | null, // key prefix to deny
  fail: false,
  written: [] as string[],
}));

vi.mock("@/lib/auth/session", () => ({ getSession: async () => state.session }));
vi.mock("@/lib/auth/supabase", () => ({ createSupabaseServerClient: async () => ({}) }));
vi.mock("@/lib/db/public", () => ({
  rateLimitOk: async (key: string, max: number, window: string) => {
    if (state.fail) throw new Error("db down");
    state.hits.push({ key, max, window });
    return !(state.deny && key.startsWith(state.deny));
  },
}));
vi.mock("@/lib/dashboard/knowledge", async (orig) => ({
  ...(await orig<typeof import("@/lib/dashboard/knowledge")>()),
  createDocument: async () => (state.written.push("create"), { ok: true, documentId: "d", chunks: 1, truncated: false }),
  reindexDocument: async () => (state.written.push("reindex"), { ok: true, chunks: 1 }),
  deleteDocument: async () => (state.written.push("delete"), { ok: true }),
}));

import { addFaq, addText, reindex, removeDocument } from "@/app/[locale]/dashboard/knowledge/actions";
import { KB_WRITE_LIMITS, checkKbWriteLimit } from "@/lib/dashboard/kb-rate-limit";

const faq = { question: "Where are you?", answer: "On Main Street." };
const asOwner = (isDemo = false) => (state.session = { role: "owner", userId: "u1", tenant: { id: "t1", is_demo: isDemo } });

beforeEach(() => {
  state.session = null;
  state.hits = [];
  state.deny = null;
  state.fail = false;
  state.written = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("knowledge-base write limits (M3)", () => {
  it("per user 10 / 10 minutes and per tenant 50 / day (20 for demo tenants)", async () => {
    expect(KB_WRITE_LIMITS.user).toEqual({ max: 10, window: "10 minutes" });
    expect(KB_WRITE_LIMITS.tenantDay).toEqual({ max: 50, window: "1 day" });
    expect(KB_WRITE_LIMITS.demoTenantDay).toEqual({ max: 20, window: "1 day" });
    asOwner();
    expect(await addFaq(faq)).toMatchObject({ ok: true });
    expect(state.hits).toEqual([
      { key: "user:u1:kb:write", max: 10, window: "10 minutes" },
      { key: "tenant:t1:kb:write:day", max: 50, window: "1 day" },
    ]);
    state.hits = [];
    asOwner(true);
    await addFaq(faq);
    expect(state.hits[1]).toEqual({ key: "tenant:t1:kb:write:day", max: 20, window: "1 day" });
  });

  it.each([
    ["user", "user:"],
    ["tenant", "tenant:"],
  ])("a blown %s limit stops addFaq, addText and reindex before anything is written", async (_n, prefix) => {
    asOwner();
    state.deny = prefix;
    const id = "11111111-1111-4111-8111-111111111111";
    expect(await addFaq(faq)).toEqual({ ok: false, code: "write_limit" });
    expect(await addText({ title: "Hours", content: "Open nine to five." })).toEqual({ ok: false, code: "write_limit" });
    expect(await reindex({ id })).toEqual({ ok: false, code: "write_limit" });
    expect(state.written).toEqual([]);
  });

  it("does not spend the limit on invalid input, anonymous users, or non-owners; deleting is not limited", async () => {
    expect(await addFaq({ question: "", answer: "" })).toEqual({ ok: false, code: "invalid" });
    expect(await addFaq(faq)).toEqual({ ok: false, code: "forbidden" });
    state.session = { role: "receptionist", userId: "u2", tenant: { id: "t1", is_demo: false } };
    expect(await addFaq(faq)).toEqual({ ok: false, code: "forbidden" });
    asOwner();
    expect(await removeDocument({ id: "11111111-1111-4111-8111-111111111111" })).toMatchObject({ ok: true });
    expect(state.hits).toEqual([]);
  });

  it("fails closed when the limiter errors", async () => {
    asOwner();
    state.fail = true;
    expect(await addFaq(faq)).toEqual({ ok: false, code: "generic" });
    expect(state.written).toEqual([]);
    expect(await checkKbWriteLimit({ userId: "u", tenant: { id: "t", is_demo: false } as never })).toBe("generic");
  });

  it("the error is localised in both languages", () => {
    for (const m of [ar, en]) expect(m.Knowledge.errors.write_limit.length).toBeGreaterThan(10);
  });
});
