import { describe, expect, it } from "vitest";
import { chunkText, ingestDocument, searchKnowledge } from "@/lib/agent/knowledge";
import { TENANT, fakeDb } from "./helpers";

describe("chunkText", () => {
  it("returns nothing for empty text and one chunk for short text", () => {
    expect(chunkText("  ")).toEqual([]);
    expect(chunkText("مرحبا بكم في العيادة")).toEqual(["مرحبا بكم في العيادة"]);
  });
  it("splits long text under the limit with overlap", () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about our opening hours.`).join(" ");
    const chunks = chunkText(text, { maxChars: 300, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(340);
  });
  it("hard-splits a single huge token run", () => {
    expect(chunkText("x".repeat(2500), { maxChars: 1000, overlap: 0 }).length).toBe(3);
  });
});

describe("ingestDocument / searchKnowledge", () => {
  it("stores chunks with the tenant id and a 768-dim vector literal", async () => {
    const { db, writes } = fakeDb({ tables: { kb_documents: { id: "doc-1" } } });
    const embedder = async (t: string[]) => t.map(() => Array(768).fill(0.5));
    const r = await ingestDocument(db, { tenantId: TENANT, title: "FAQ", content: "Parking is free.\n\nWe open at 9." }, embedder);
    expect(r.documentId).toBe("doc-1");
    const chunkWrite = writes.find((w) => w.table === "kb_chunks")!;
    const row = (chunkWrite.payload as { tenant_id: string; embedding: string }[])[0];
    expect(row.tenant_id).toBe(TENANT);
    expect(row.embedding.startsWith("[") && row.embedding.split(",").length === 768).toBe(true);
  });

  it("removes the document if embedding fails", async () => {
    const { db, writes } = fakeDb({ tables: { kb_documents: { id: "doc-1" } } });
    await expect(
      ingestDocument(db, { tenantId: TENANT, title: "x", content: "hello world" }, async () => {
        throw new Error("quota");
      }),
    ).rejects.toThrow("quota");
    expect(writes.some((w) => w.table === "kb_documents" && w.op === "delete")).toBe(true);
  });

  it("queries match_kb_chunks with the given tenant", async () => {
    const { db, rpcCalls } = fakeDb({
      rpc: { match_kb_chunks: { data: [{ id: "1", document_id: "d", content: "c", similarity: 0.9 }] } },
    });
    const rows = await searchKnowledge(db, TENANT, "parking", 3, async () => [0.1, 0.2]);
    expect(rows).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({ fn: "match_kb_chunks", args: { p_tenant_id: TENANT, p_k: 3 } });
  });
});
