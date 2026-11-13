import { describe, expect, it, vi } from "vitest";
import {
  EMBED_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  MAX_DOC_CHARS,
  chunkText,
  deriveDocStatus,
  embedInBatches,
  indexDocument,
  isRetryableEmbeddingError,
  mockEmbedder,
  sanitizeKbText,
  withRetry,
} from "@/lib/agent/knowledge";
import type { AgentDb } from "@/lib/agent/types";
import { createDocument, deleteDocument, mapKbError, reindexDocument } from "@/lib/dashboard/knowledge";
import { canManageKnowledge, canViewConversations, navFor } from "@/lib/auth/roles";

const TENANT = "d0000000-0000-4000-8000-000000000001";
const DOC = "ab000000-0000-4000-8000-000000000001";
const noSleep = async () => {};
const vec = () => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);
const okEmbedder = async (t: string[]) => t.map(vec);
const apiError = (statusCode: number) => Object.assign(new Error(`http ${statusCode}`), { statusCode });

type Res = { data?: unknown; error?: { code?: string; message?: string } | null };

/** Recording fake: results are looked up by "table.op"; every call and filter is captured. */
function fakeDb(results: Record<string, Res | Res[]> = {}) {
  const calls: { table: string; op: string; payload?: unknown; filters: [string, unknown][] }[] = [];
  const counters: Record<string, number> = {};
  const db = {
    from(table: string) {
      let op = "select";
      const entry = { table, op, payload: undefined as unknown, filters: [] as [string, unknown][] };
      const q: Record<string, unknown> = {};
      const result = (): Res => {
        const key = `${table}.${entry.op}`;
        const r = results[key];
        if (Array.isArray(r)) return r[Math.min(counters[key] = (counters[key] ?? -1) + 1, r.length - 1)];
        return r ?? { data: [], error: null };
      };
      for (const m of ["select", "order", "limit", "range", "is"]) q[m] = () => q;
      for (const m of ["eq", "in"]) {
        q[m] = (col: string, v: unknown) => {
          entry.filters.push([col, v]);
          return q;
        };
      }
      for (const m of ["insert", "update", "delete"]) {
        q[m] = (payload?: unknown) => {
          op = m;
          entry.op = m;
          entry.payload = payload;
          return q;
        };
      }
      calls.push(entry);
      q.single = async () => ({ error: null, ...result() });
      q.maybeSingle = async () => ({ error: null, ...result() });
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ error: null, ...result() }).then(res);
      void op;
      return q;
    },
  } as unknown as AgentDb;
  return { db, calls };
}

describe("sanitizeKbText", () => {
  it("strips control, bidi override and zero-width characters but keeps Arabic and newlines", () => {
    const dirty = "مرحبا\u0000 بكم‮​\u0007\r\nسطر ثانٍ⁦x⁩﻿\tend";
    const { text, truncated } = sanitizeKbText(dirty);
    expect(text).toBe("مرحبا بكم\nسطر ثانٍx\tend");
    expect(truncated).toBe(false);
  });
  it("does not strip Arabic letters or ZWNJ", () => {
    expect(sanitizeKbText("می‌خواهم").text).toBe("می‌خواهم");
  });
  it("caps the length and says so", () => {
    const { text, truncated } = sanitizeKbText("a".repeat(MAX_DOC_CHARS + 500));
    expect(text.length).toBe(MAX_DOC_CHARS);
    expect(truncated).toBe(true);
  });
  it("leaves markup as inert text (it is rendered by React as text, never as HTML)", () => {
    expect(sanitizeKbText("<script>alert(1)</script>").text).toBe("<script>alert(1)</script>");
  });
});

describe("chunking limits", () => {
  it("never produces more chunks than the document cap allows for", () => {
    const long = Array.from({ length: 4000 }, (_, i) => `جملة رقم ${i} عن ساعات العمل.`).join(" ");
    const { text } = sanitizeKbText(long);
    const chunks = chunkText(text);
    expect(chunks.length).toBeLessThanOrEqual(Math.ceil(MAX_DOC_CHARS / 900) * 2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1050);
  });
});

describe("retry with backoff", () => {
  it("retries 429 and 5xx with growing delays, then succeeds", async () => {
    // jitter is Math.random()*200: pin it so the delays are exact (no flakiness from the random part)
    const rnd = vi.spyOn(Math, "random");
    try {
      for (const [r, jitter] of [[0, 0], [0.5, 100], [0.999, 199]] as const) {
        rnd.mockReturnValue(r);
        const sleep = vi.fn(async (ms: number) => void ms);
        const fn = vi.fn().mockRejectedValueOnce(apiError(429)).mockRejectedValueOnce(apiError(503)).mockResolvedValue("ok");
        await expect(withRetry(fn, { sleep, baseMs: 100 })).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledTimes(3);
        expect(sleep.mock.calls.map((c) => c[0])).toEqual([100 + jitter, 200 + jitter]);
      }
    } finally {
      rnd.mockRestore();
    }
  });
  it("does not retry a 400", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(400));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow("http 400");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("gives up after the attempt limit", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(500));
    await expect(withRetry(fn, { sleep: noSleep, attempts: 3 })).rejects.toThrow("http 500");
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("classifies errors (also when wrapped by the SDK's retry error)", () => {
    expect(isRetryableEmbeddingError(apiError(429))).toBe(true);
    expect(isRetryableEmbeddingError(apiError(502))).toBe(true);
    expect(isRetryableEmbeddingError(apiError(401))).toBe(false);
    expect(isRetryableEmbeddingError({ lastError: apiError(503) })).toBe(true);
    expect(isRetryableEmbeddingError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableEmbeddingError(new Error("boom"))).toBe(false);
  });
  it("embeds in small batches and retries a batch independently", async () => {
    const texts = Array.from({ length: EMBED_BATCH_SIZE * 2 + 3 }, (_, i) => `t${i}`);
    const sizes: number[] = [];
    let failedOnce = false;
    const embedder = async (b: string[]) => {
      sizes.push(b.length);
      if (!failedOnce && sizes.length === 2) {
        failedOnce = true;
        throw apiError(429);
      }
      return b.map(vec);
    };
    const out = await embedInBatches(texts, embedder, { sleep: noSleep });
    expect(out).toHaveLength(texts.length);
    expect(Math.max(...sizes)).toBe(EMBED_BATCH_SIZE);
    expect(sizes).toEqual([16, 16, 16, 3]); // the second batch was retried once
  });
  it("rejects vectors of the wrong dimension", async () => {
    await expect(embedInBatches(["a"], async () => [[1, 2, 3]], { sleep: noSleep })).rejects.toThrow(
      "embedding_shape_mismatch",
    );
  });
});

describe("derived document status", () => {
  it("is ready only with chunks and no missing embeddings", () => {
    expect(deriveDocStatus({ chunkCount: 3, unembedded: 0 })).toBe("ready");
    expect(deriveDocStatus({ chunkCount: 0, unembedded: 0 })).toBe("failed");
    expect(deriveDocStatus({ chunkCount: 3, unembedded: 1 })).toBe("failed");
  });
});

describe("indexDocument", () => {
  it("chunks content and inserts tenant-scoped 768-dim rows", async () => {
    const { db, calls } = fakeDb({ "kb_chunks.select": { data: [] } });
    const r = await indexDocument(db, { tenantId: TENANT, documentId: DOC, content: "Parking is free.\n\nWe open at 9." }, okEmbedder, {
      sleep: noSleep,
    });
    expect(r.chunks).toBeGreaterThan(0);
    const ins = calls.find((c) => c.op === "insert")!;
    const row = (ins.payload as { tenant_id: string; document_id: string; embedding: string }[])[0];
    expect(row.tenant_id).toBe(TENANT);
    expect(row.document_id).toBe(DOC);
    expect(row.embedding.split(",").length).toBe(EMBEDDING_DIMENSIONS);
  });

  it("writes nothing when embedding fails for good (no partial chunks)", async () => {
    const { db, calls } = fakeDb({ "kb_chunks.select": { data: [] } });
    await expect(
      indexDocument(db, { tenantId: TENANT, documentId: DOC, content: "hello world" }, async () => {
        throw apiError(503);
      }, { sleep: noSleep }),
    ).rejects.toThrow("http 503");
    expect(calls.some((c) => c.op === "insert" || c.op === "update" || c.op === "delete")).toBe(false);
  });

  it("removes the chunks it added when an insert fails (demo_limit)", async () => {
    const { db, calls } = fakeDb({
      "kb_chunks.select": { data: [] },
      "kb_chunks.insert": { error: { code: "54000", message: "demo_limit" } },
    });
    await expect(
      indexDocument(db, { tenantId: TENANT, documentId: DOC, content: "hello world" }, okEmbedder, { sleep: noSleep }),
    ).rejects.toMatchObject({ code: "54000" });
    const del = calls.find((c) => c.op === "delete")!;
    expect(del.table).toBe("kb_chunks");
    expect(del.filters).toEqual([
      ["tenant_id", TENANT],
      ["document_id", DOC],
    ]);
  });

  it("re-embeds existing chunks in place instead of re-chunking stored content", async () => {
    const { db, calls } = fakeDb({
      "kb_chunks.select": { data: [{ id: "c1", content: "ساعات العمل" }, { id: "c2", content: "العربون" }] },
    });
    const r = await indexDocument(db, { tenantId: TENANT, documentId: DOC, content: "stub" }, okEmbedder, { sleep: noSleep });
    expect(r.chunks).toBe(2);
    expect(calls.filter((c) => c.op === "update")).toHaveLength(2);
    expect(calls.some((c) => c.op === "insert" || c.op === "delete")).toBe(false);
  });

  it("throws empty_document for blank content", async () => {
    const { db } = fakeDb({ "kb_chunks.select": { data: [] } });
    await expect(indexDocument(db, { tenantId: TENANT, documentId: DOC, content: "  " }, okEmbedder)).rejects.toThrow(
      "empty_document",
    );
  });
});

const session = (role: "owner" | "receptionist" | "provider") =>
  ({ role, tenant: { id: TENANT } }) as Parameters<typeof createDocument>[1];

describe("createDocument / reindex / delete", () => {
  it("refuses non-owners before touching the database", async () => {
    for (const role of ["receptionist", "provider"] as const) {
      const { db, calls } = fakeDb();
      expect(await createDocument(db, session(role), { title: "t", content: "hello there", sourceType: "text" }, okEmbedder)).toEqual({
        ok: false,
        code: "forbidden",
      });
      expect(await reindexDocument(db, session(role), DOC, okEmbedder)).toMatchObject({ code: "forbidden" });
      expect(await deleteDocument(db, session(role), DOC)).toMatchObject({ code: "forbidden" });
      expect(calls).toHaveLength(0);
    }
  });

  it("scopes the insert to the session tenant and sanitises title and content", async () => {
    const { db, calls } = fakeDb({
      "kb_documents.insert": { data: { id: DOC } },
      "kb_chunks.select": { data: [] },
    });
    const r = await createDocument(
      db,
      session("owner"),
      { title: "  Hours\u0000 ‮ ", content: "We open at 9.\u0007", sourceType: "faq" },
      okEmbedder,
      { sleep: noSleep },
    );
    expect(r).toMatchObject({ ok: true, documentId: DOC });
    const ins = calls.find((c) => c.table === "kb_documents" && c.op === "insert")!;
    expect(ins.payload).toMatchObject({ tenant_id: TENANT, title: "Hours", content: "We open at 9.", source_type: "faq" });
  });

  it("keeps the document (for retry) and reports rate limiting when embedding keeps failing", async () => {
    const { db, calls } = fakeDb({ "kb_documents.insert": { data: { id: DOC } }, "kb_chunks.select": { data: [] } });
    const r = await createDocument(db, session("owner"), { title: "t", content: "hello there", sourceType: "text" }, async () => {
      throw apiError(429);
    }, { sleep: noSleep });
    expect(r).toEqual({ ok: false, code: "rate_limited", documentId: DOC });
    expect(calls.some((c) => c.table === "kb_documents" && c.op === "delete")).toBe(false);
  });

  it("maps the demo document cap to demo_limit", async () => {
    const { db } = fakeDb({ "kb_documents.insert": { error: { code: "54000", message: "demo_limit" } } });
    expect(await createDocument(db, session("owner"), { title: "t", content: "hello there", sourceType: "text" }, okEmbedder)).toEqual({
      ok: false,
      code: "demo_limit",
    });
  });

  it("rejects text that is only invisible characters", async () => {
    const { db, calls } = fakeDb();
    const r = await createDocument(db, session("owner"), { title: "t", content: "​\u0000 ‮", sourceType: "text" }, okEmbedder);
    expect(r).toEqual({ ok: false, code: "empty" });
    expect(calls).toHaveLength(0);
  });

  it("delete is tenant-scoped and reports not_found when nothing matched", async () => {
    const hit = fakeDb({ "kb_documents.delete": { data: [{ id: DOC }] } });
    expect(await deleteDocument(hit.db, session("owner"), DOC)).toEqual({ ok: true });
    expect(hit.calls[0].filters).toContainEqual(["tenant_id", TENANT]);
    const miss = fakeDb({ "kb_documents.delete": { data: [] } });
    expect(await deleteDocument(miss.db, session("owner"), DOC)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("reindex of an unknown document is not_found", async () => {
    const { db } = fakeDb({ "kb_documents.select": { data: null } });
    expect(await reindexDocument(db, session("owner"), DOC, okEmbedder)).toMatchObject({ code: "not_found" });
  });

  it("maps errors to codes", () => {
    expect(mapKbError(new Error("empty_document"))).toBe("empty");
    expect(mapKbError({ code: "42501", message: "new row violates row-level security" })).toBe("forbidden");
    expect(mapKbError(apiError(429))).toBe("rate_limited");
    expect(mapKbError(apiError(500))).toBe("embedding_failed");
  });
});

describe("mock embedder (offline path)", () => {
  it("returns unit-ish 768-dim vectors and fails on the FAILME marker", async () => {
    const [v] = await mockEmbedder(["hello"]);
    expect(v).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    await expect(mockEmbedder(["x FAILME"])).rejects.toThrow();
  });
});

describe("role gating", () => {
  it("only the owner manages knowledge; owner and receptionist see conversations", () => {
    expect(canManageKnowledge("owner")).toBe(true);
    expect(canManageKnowledge("receptionist")).toBe(false);
    expect(canManageKnowledge("provider")).toBe(false);
    expect(canViewConversations("owner")).toBe(true);
    expect(canViewConversations("receptionist")).toBe(true);
    expect(canViewConversations("provider")).toBe(false);
  });
  it("shows the nav entries per role", () => {
    const keys = (r: "owner" | "receptionist" | "provider") => navFor(r).map((i) => i.key);
    expect(keys("owner")).toEqual(expect.arrayContaining(["knowledge", "conversations"]));
    expect(keys("receptionist")).toContain("conversations");
    expect(keys("receptionist")).not.toContain("knowledge");
    expect(keys("provider")).not.toContain("conversations");
    expect(keys("provider")).not.toContain("knowledge");
  });
});
