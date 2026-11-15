import { embed, embedMany } from "ai";
import { getKeyPool, googleFor, withKeyFailover } from "./key-pool";
import type { AgentDb } from "./types";

/** Must match supabase kb_chunks.embedding vector(768). */
export const EMBEDDING_DIMENSIONS = 768;
const EMBEDDING_MODEL = "gemini-embedding-001";

export type ChunkOptions = { maxChars?: number; overlap?: number };

/** Split text on paragraph/sentence boundaries into ~maxChars chunks with a small overlap. */
export function chunkText(text: string, { maxChars = 900, overlap = 120 }: ChunkOptions = {}): string[] {
  const clean = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!clean) return [];
  const units = clean
    .split(/\n{2,}/)
    .flatMap((p) => (p.length <= maxChars ? [p] : (p.match(/[^.!?؟۔\n]+[.!?؟۔]?\s*/g) ?? [p])))
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
  };
  for (const u of units) {
    const pieces = u.length > maxChars ? (u.match(new RegExp(`.{1,${maxChars}}`, "gs")) ?? [u]) : [u];
    for (const piece of pieces) {
      if (cur && cur.length + piece.length + 1 > maxChars) {
        push();
        cur = overlap > 0 ? cur.slice(-overlap).replace(/^\S*\s/, "") : "";
      }
      cur = cur ? `${cur} ${piece}` : piece;
    }
  }
  push();
  return chunks;
}

function l2Normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

const toPgVector = (v: number[]) => `[${v.join(",")}]`;

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const pool = getKeyPool();
  const { embeddings } = await withKeyFailover(pool, `embed:${EMBEDDING_MODEL}`, (i) =>
    embedMany({
      model: googleFor(pool, i).embedding(EMBEDDING_MODEL),
      values: texts,
      // retries (with backoff and a small batch size) are handled by embedInBatches
      maxRetries: 0,
      providerOptions: {
        google: {
          outputDimensionality: EMBEDDING_DIMENSIONS,
          taskType: "RETRIEVAL_DOCUMENT",
        },
      },
    }),
  );
  return embeddings.map(l2Normalize);
}

export async function embedQuery(text: string): Promise<number[]> {
  const pool = getKeyPool();
  const { embedding } = await withKeyFailover(pool, `embed:${EMBEDDING_MODEL}`, (i) =>
    embed({
      model: googleFor(pool, i).embedding(EMBEDDING_MODEL),
      value: text,
      // with several keys the next key is the retry; a single key keeps the SDK's default retries
      ...(pool.size > 1 ? { maxRetries: 0 } : {}),
      providerOptions: {
        google: {
          outputDimensionality: EMBEDDING_DIMENSIONS,
          taskType: "RETRIEVAL_QUERY",
        },
      },
    }),
  );
  return l2Normalize(embedding);
}

export type IngestInput = {
  tenantId: string;
  title: string;
  content: string;
  sourceType?: "pdf" | "faq" | "text";
  storagePath?: string;
};

/** Chunk, embed and store a document. Returns the document id and chunk count. */
export async function ingestDocument(
  db: AgentDb,
  input: IngestInput,
  embedder: (texts: string[]) => Promise<number[][]> = embedTexts,
) {
  const chunks = chunkText(input.content);
  if (chunks.length === 0) throw new Error("empty_document");

  const { data: doc, error } = await db
    .from("kb_documents")
    .insert({
      tenant_id: input.tenantId,
      title: input.title,
      source_type: input.sourceType ?? "text",
      storage_path: input.storagePath ?? null,
      content: input.content,
    })
    .select("id")
    .single();
  if (error || !doc) throw error ?? new Error("insert_failed");
  const documentId = (doc as { id: string }).id;

  try {
    const vectors = await embedder(chunks);
    const rows = chunks.map((content, i) => ({
      tenant_id: input.tenantId,
      document_id: documentId,
      chunk_index: i,
      content,
      embedding: toPgVector(vectors[i]),
    }));
    for (let i = 0; i < rows.length; i += 50) {
      const { error: e } = await db.from("kb_chunks").insert(rows.slice(i, i + 50));
      if (e) throw e;
    }
  } catch (e) {
    // do not leave a half-indexed document behind
    await db.from("kb_documents").delete().eq("id", documentId).eq("tenant_id", input.tenantId);
    throw e;
  }
  return { documentId, chunks: chunks.length };
}

/** Query through match_kb_chunks. */
export async function searchKnowledge(
  db: AgentDb,
  tenantId: string,
  query: string,
  k = 4,
  embedder: (t: string) => Promise<number[]> = embedQuery,
  sessionHash: string | null = null,
) {
  const vector = await embedder(query);
  const { data, error } = await db.rpc("match_kb_chunks", {
    p_tenant_id: tenantId,
    p_embedding: toPgVector(vector),
    p_k: k,
    p_session_hash: sessionHash,
  });
  if (error) throw error;
  return (data ?? []) as {
    id: string;
    document_id: string;
    content: string;
    similarity: number;
  }[];
}

// ---------------------------------------------------------------------------------------------
// Dashboard indexing: sanitising, batching, retry, and a failure model that never leaves partial
// chunks. A document's state is DERIVED (the schema has no status column): see deriveDocStatus.
// ---------------------------------------------------------------------------------------------

/** Total characters kept per document (about 70 chunks). Anything beyond is cut off. */
export const MAX_DOC_CHARS = 60_000;
export const MAX_TITLE_CHARS = 120;
/** Texts per embedding request. Small on purpose: the free tier is rate limited. */
export const EMBED_BATCH_SIZE = 16;
export const EMBED_MAX_ATTEMPTS = 4;

// C0/C1 controls except \t \n, DEL, bidi embedding/override/isolate controls, zero-width and BOM.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​‎‏‪-‮⁠⁦-⁩﻿]/g;

/**
 * Cleans untrusted text before it is stored (the assistant reads it later): normalises newlines,
 * drops control and invisible characters and caps the length. Returns whether it was cut.
 */
export function sanitizeKbText(raw: string, maxChars = MAX_DOC_CHARS): { text: string; truncated: boolean } {
  const cleaned = raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_CHARS, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length <= maxChars) return { text: cleaned, truncated: false };
  return { text: cleaned.slice(0, maxChars).trim(), truncated: true };
}

export function sanitizeTitle(raw: string): string {
  return sanitizeKbText(raw, MAX_TITLE_CHARS).text.replace(/\s+/g, " ").trim();
}

function statusOf(err: unknown): number | null {
  const e = err as { statusCode?: unknown; status?: unknown } | null;
  if (typeof e?.statusCode === "number") return e.statusCode;
  if (typeof e?.status === "number") return e.status;
  return null;
}

/** True for rate limits (429), server errors (5xx) and network-level failures; false for other 4xx. */
export function isRetryableEmbeddingError(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== null) return status === 429 || status >= 500;
  const e = err as { lastError?: unknown; cause?: unknown } | null;
  if (e?.lastError) return isRetryableEmbeddingError(e.lastError);
  if (e?.cause) return isRetryableEmbeddingError(e.cause);
  // fetch failures and timeouts surface as TypeError / AbortError
  return err instanceof TypeError || (err as { name?: string } | null)?.name === "AbortError";
}

/** Classifies an embedding failure for the UI. */
export function embeddingFailureKind(err: unknown): "rate_limited" | "embedding_failed" {
  if (statusOf(err) === 429) return "rate_limited";
  const last = (err as { lastError?: unknown } | null)?.lastError;
  return last ? embeddingFailureKind(last) : "embedding_failed";
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retries `fn` with exponential backoff and jitter while the error is retryable. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    attempts = EMBED_MAX_ATTEMPTS,
    baseMs = 800,
    sleep = realSleep,
    retryable = isRetryableEmbeddingError,
  }: {
    attempts?: number;
    baseMs?: number;
    sleep?: Sleep;
    retryable?: (e: unknown) => boolean;
  } = {},
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1 || !retryable(e)) throw e;
      await sleep(baseMs * 2 ** i + Math.floor(Math.random() * 200));
    }
  }
}

export type Embedder = (texts: string[]) => Promise<number[][]>;

/** Embeds in small batches, each retried with backoff. Throws if any batch finally fails. */
export async function embedInBatches(
  texts: string[],
  embedder: Embedder,
  opts: { batchSize?: number; sleep?: Sleep; baseMs?: number } = {},
): Promise<number[][]> {
  const size = opts.batchSize ?? EMBED_BATCH_SIZE;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    const vectors = await withRetry(() => embedder(batch), {
      sleep: opts.sleep,
      baseMs: opts.baseMs,
    });
    if (vectors.length !== batch.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error("embedding_shape_mismatch");
    }
    out.push(...vectors);
  }
  return out;
}

/** Deterministic offline embedder for tests and e2e (DAWRAK_MOCK_EMBEDDINGS=1). Text containing FAILME fails. */
export async function mockEmbedder(texts: string[]): Promise<number[][]> {
  if (texts.some((t) => t.includes("FAILME"))) {
    throw Object.assign(new Error("mock embedding failure"), {
      statusCode: 400,
    });
  }
  return texts.map((t) => {
    const v = Array.from(
      { length: EMBEDDING_DIMENSIONS },
      (_, i) => Math.sin(i * 12.9898 + t.length) + ((t.charCodeAt(i % t.length) || 0) % 7),
    );
    return l2Normalize(v);
  });
}

/** The real Gemini embedder, or the offline mock when DAWRAK_MOCK_EMBEDDINGS=1. */
export function getEmbedder(): Embedder {
  return process.env.DAWRAK_MOCK_EMBEDDINGS === "1" ? mockEmbedder : embedTexts;
}

export type DocStatus = "ready" | "failed";

/**
 * kb_documents has no status column, so state is derived: a document with no chunks, or with a
 * chunk whose embedding is missing, is `failed` (needs re-index); otherwise `ready`.
 */
export function deriveDocStatus(s: { chunkCount: number; unembedded: number }): DocStatus {
  return s.chunkCount > 0 && s.unembedded === 0 ? "ready" : "failed";
}

/**
 * Indexes one document: re-embeds its existing chunks when it has some (fills missing embeddings,
 * keeps the stored text), otherwise chunks `content` and inserts. All embedding happens before any
 * write, and a failed insert removes the chunks it added, so a failure never leaves partial chunks.
 */
export async function indexDocument(
  db: AgentDb,
  p: { tenantId: string; documentId: string; content: string | null },
  embedder: Embedder = getEmbedder(),
  opts: { sleep?: Sleep; baseMs?: number } = {},
): Promise<{ chunks: number }> {
  const { data: existing, error: selErr } = await db
    .from("kb_chunks")
    .select("id, content")
    .eq("tenant_id", p.tenantId)
    .eq("document_id", p.documentId)
    .order("chunk_index", { ascending: true })
    .limit(1000);
  if (selErr) throw selErr;
  const rows = (existing ?? []) as { id: string; content: string }[];

  if (rows.length > 0) {
    const vectors = await embedInBatches(
      rows.map((r) => r.content),
      embedder,
      opts,
    );
    for (let i = 0; i < rows.length; i += 10) {
      const results = await Promise.all(
        rows.slice(i, i + 10).map((r, j) =>
          db
            .from("kb_chunks")
            .update({ embedding: toPgVector(vectors[i + j]) })
            .eq("id", r.id)
            .eq("tenant_id", p.tenantId),
        ),
      );
      const bad = results.find((r) => r.error);
      if (bad?.error) throw bad.error;
    }
    return { chunks: rows.length };
  }

  const chunks = chunkText(p.content ?? "");
  if (chunks.length === 0) throw new Error("empty_document");
  const vectors = await embedInBatches(chunks, embedder, opts);
  const inserts = chunks.map((content, i) => ({
    tenant_id: p.tenantId,
    document_id: p.documentId,
    chunk_index: i,
    content,
    embedding: toPgVector(vectors[i]),
  }));
  try {
    for (let i = 0; i < inserts.length; i += 50) {
      const { error } = await db.from("kb_chunks").insert(inserts.slice(i, i + 50));
      if (error) throw error;
    }
  } catch (e) {
    await db.from("kb_chunks").delete().eq("tenant_id", p.tenantId).eq("document_id", p.documentId);
    throw e;
  }
  return { chunks: inserts.length };
}
