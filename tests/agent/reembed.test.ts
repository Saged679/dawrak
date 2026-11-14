import { describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSIONS } from "@/lib/agent/knowledge";
import { reembedMissing } from "@/lib/agent/reembed";
import type { AgentDb } from "@/lib/agent/types";

type Chunk = { id: string; tenant_id: string; content: string; embedding: string | null };

/** Minimal supabase-js stand-in for the queries reembedMissing makes. */
function fakeKb(chunks: Chunk[], demoIds: string[]) {
  const updates: { id: string; columns: string[] }[] = [];
  const db = {
    from(table: string) {
      const f: { table: string; isNull: boolean; inIds?: string[]; notIn?: string[]; eq: Record<string, unknown>; limit?: number; update?: Record<string, unknown> } = {
        table,
        isNull: false,
        eq: {},
      };
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.is = () => ((f.isNull = true), q);
      q.in = (_c: string, ids: string[]) => ((f.inIds = ids), q);
      q.not = (_c: string, _op: string, list: string) => ((f.notIn = list.replace(/[()]/g, "").split(",")), q);
      q.eq = (c: string, v: unknown) => ((f.eq[c] = v), q);
      q.limit = (n: number) => ((f.limit = n), q);
      q.update = (payload: Record<string, unknown>) => ((f.update = payload), q);
      q.then = (res: (v: unknown) => unknown) => {
        if (f.table === "tenants") return Promise.resolve({ data: demoIds.map((id) => ({ id })), error: null }).then(res);
        if (f.update) {
          const c = chunks.find((x) => x.id === f.eq.id && x.tenant_id === f.eq.tenant_id && (!f.isNull || x.embedding === null));
          updates.push({ id: String(f.eq.id), columns: Object.keys(f.update) });
          if (c) c.embedding = String(f.update.embedding);
          return Promise.resolve({ data: null, error: null }).then(res);
        }
        let rows = chunks.filter((c) => c.embedding === null);
        if (f.inIds) rows = rows.filter((c) => f.inIds!.includes(c.tenant_id));
        if (f.notIn) rows = rows.filter((c) => !f.notIn!.includes(c.tenant_id));
        return Promise.resolve({ data: rows.slice(0, f.limit).map(({ id, tenant_id, content }) => ({ id, tenant_id, content })), error: null }).then(res);
      };
      return q;
    },
  } as unknown as AgentDb;
  return { db, updates };
}

const vec = () => Array(EMBEDDING_DIMENSIONS).fill(0.5);
const mk = (n: number, tenant: string, prefix: string): Chunk[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, tenant_id: tenant, content: `secret content ${prefix}${i}`, embedding: null }));

describe("reembedMissing (cron step)", () => {
  it("embeds up to the limit, demo tenants first, and updates only the embedding column", async () => {
    const chunks = [...mk(5, "shop", "s"), ...mk(20, "demo", "d")];
    const { db, updates } = fakeKb(chunks, ["demo"]);
    const embedder = vi.fn(async (t: string[]) => t.map(vec));
    const r = await reembedMissing(db, { embedder, limit: 24 });
    expect(r).toEqual({ embedded: 24 });
    // all 20 demo chunks, then 4 of the 5 others
    expect(chunks.filter((c) => c.tenant_id === "demo").every((c) => c.embedding !== null)).toBe(true);
    expect(chunks.filter((c) => c.tenant_id === "shop" && c.embedding !== null)).toHaveLength(4);
    expect(embedder).toHaveBeenCalledTimes(1);
    expect(updates.every((u) => u.columns.length === 1 && u.columns[0] === "embedding")).toBe(true);
  });

  it("skips silently without a Gemini key (no calls)", async () => {
    const { db } = fakeKb(mk(3, "demo", "d"), ["demo"]);
    expect(await reembedMissing(db, { hasKey: false })).toEqual({ embedded: 0, skipped: "no_key" });
  });

  it("a quota error is skipped quietly and never thrown or logged with content", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const chunks = mk(3, "demo", "d");
    const { db } = fakeKb(chunks, ["demo"]);
    const embedder = async () => {
      throw Object.assign(new Error("RESOURCE_EXHAUSTED secret content d0"), { statusCode: 429 });
    };
    expect(await reembedMissing(db, { embedder })).toEqual({ embedded: 0, skipped: "quota" });
    expect(chunks.every((c) => c.embedding === null)).toBe(true);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("other failures return 'error', never throw, and never log chunk content", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeKb(mk(2, "demo", "d"), ["demo"]);
    const r = await reembedMissing(db, { embedder: async () => { throw new Error("secret content d0 leaked?"); } });
    expect(r).toEqual({ embedded: 0, skipped: "error" });
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret content");
    err.mockRestore();
  });

  it("a wrong-sized vector is rejected (nothing written)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const chunks = mk(2, "demo", "d");
    const { db } = fakeKb(chunks, ["demo"]);
    const r = await reembedMissing(db, { embedder: async (t) => t.map(() => [1, 2, 3]) });
    expect(r.skipped).toBe("error");
    expect(chunks.every((c) => c.embedding === null)).toBe(true);
  });

  it("nothing to do when every chunk has an embedding", async () => {
    const chunks = mk(2, "demo", "d").map((c) => ({ ...c, embedding: "[1]" }));
    const { db } = fakeKb(chunks, ["demo"]);
    const embedder = vi.fn();
    expect(await reembedMissing(db, { embedder })).toEqual({ embedded: 0, skipped: "nothing_to_do" });
    expect(embedder).not.toHaveBeenCalled();
  });
});
