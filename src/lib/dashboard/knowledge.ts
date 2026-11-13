import "server-only";
import { z } from "zod";
import {
  MAX_DOC_CHARS,
  MAX_TITLE_CHARS,
  chunkText,
  deriveDocStatus,
  embeddingFailureKind,
  getEmbedder,
  indexDocument,
  sanitizeKbText,
  sanitizeTitle,
  type DocStatus,
  type Embedder,
} from "@/lib/agent/knowledge";
import type { AgentDb } from "@/lib/agent/types";
import { canManageKnowledge } from "@/lib/auth/roles";
import type { SessionContext } from "@/lib/auth/session";
import { mapWriteError, type WriteErrorCode } from "./errors";

export const KB_PAGE_SIZE = 20;

export type KbErrorCode =
  | WriteErrorCode
  | "empty"
  | "not_pdf"
  | "too_large"
  | "no_text"
  | "pdf_unreadable"
  | "rate_limited"
  | "write_limit"
  | "embedding_failed";

export type KbResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; code: KbErrorCode; documentId?: string };

export const faqInput = z.object({
  question: z.string().trim().min(2).max(500),
  answer: z.string().trim().min(2).max(4000),
});

export const textInput = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  content: z.string().trim().min(2).max(MAX_DOC_CHARS * 2),
});

export const idInput = z.object({ id: z.uuid() });

/** Maps any thrown error from indexing or a write to a localisable code. */
export function mapKbError(e: unknown): KbErrorCode {
  if ((e as Error)?.message === "empty_document") return "empty";
  const err = e as { code?: string | null; message?: string | null };
  // Supabase errors carry a SQLSTATE `code`; embedding errors carry a statusCode or no code.
  if (typeof err?.code === "string" && /^[0-9A-Z]{5}$/.test(err.code)) return mapWriteError(err);
  if (typeof err?.message === "string" && /demo_limit|demo_readonly/.test(err.message)) return mapWriteError(err);
  return embeddingFailureKind(e);
}

/**
 * Stores a document row first (so a failed embedding can be retried from the saved text), then
 * indexes it. On an indexing failure the document stays with NO chunks, which the list shows as
 * `failed` with a retry button.
 */
export async function createDocument(
  db: AgentDb,
  session: Pick<SessionContext, "role" | "tenant">,
  input: { title: string; content: string; sourceType: "faq" | "text" | "pdf" },
  embedder: Embedder = getEmbedder(),
  opts: { sleep?: (ms: number) => Promise<void>; baseMs?: number } = {},
): Promise<KbResult<{ documentId: string; chunks: number; truncated: boolean }>> {
  if (!canManageKnowledge(session.role)) return { ok: false, code: "forbidden" };
  const title = sanitizeTitle(input.title);
  const { text, truncated } = sanitizeKbText(input.content);
  if (!title || chunkText(text).length === 0) return { ok: false, code: "empty" };

  const tenantId = session.tenant.id;
  const { data, error } = await db
    .from("kb_documents")
    .insert({ tenant_id: tenantId, title, source_type: input.sourceType, content: text })
    .select("id")
    .single();
  if (error || !data) return { ok: false, code: mapKbError(error ?? new Error("insert_failed")) };
  const documentId = (data as { id: string }).id;

  try {
    const { chunks } = await indexDocument(db, { tenantId, documentId, content: text }, embedder, opts);
    return { ok: true, documentId, chunks, truncated };
  } catch (e) {
    console.error("kb_index_error", (e as { code?: string }).code ?? (e as Error)?.name);
    return { ok: false, code: mapKbError(e), documentId };
  }
}

export async function reindexDocument(
  db: AgentDb,
  session: Pick<SessionContext, "role" | "tenant">,
  id: string,
  embedder: Embedder = getEmbedder(),
  opts: { sleep?: (ms: number) => Promise<void>; baseMs?: number } = {},
): Promise<KbResult<{ chunks: number }>> {
  if (!canManageKnowledge(session.role)) return { ok: false, code: "forbidden" };
  const tenantId = session.tenant.id;
  const { data, error } = await db
    .from("kb_documents")
    .select("id, content")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) return { ok: false, code: mapKbError(error) };
  if (!data) return { ok: false, code: "not_found" };
  try {
    const { chunks } = await indexDocument(
      db,
      { tenantId, documentId: id, content: (data as { content: string | null }).content },
      embedder,
      opts,
    );
    return { ok: true, chunks };
  } catch (e) {
    console.error("kb_reindex_error", (e as { code?: string }).code ?? (e as Error)?.name);
    return { ok: false, code: mapKbError(e), documentId: id };
  }
}

export async function deleteDocument(
  db: AgentDb,
  session: Pick<SessionContext, "role" | "tenant">,
  id: string,
): Promise<KbResult> {
  if (!canManageKnowledge(session.role)) return { ok: false, code: "forbidden" };
  // kb_chunks has ON DELETE CASCADE on (document_id, tenant_id).
  const { data, error } = await db
    .from("kb_documents")
    .delete()
    .eq("id", id)
    .eq("tenant_id", session.tenant.id)
    .select("id");
  if (error) return { ok: false, code: mapKbError(error) };
  if (!data || data.length === 0) return { ok: false, code: "not_found" };
  return { ok: true };
}

export type KbDocumentRow = {
  id: string;
  title: string;
  sourceType: "faq" | "text" | "pdf";
  createdAt: string;
  chunkCount: number;
  status: DocStatus;
  /** auth user that created the row (null for seeded rows); used to lock seeded rows in the demo */
  createdBy: string | null;
};

/** One page of documents with chunk counts and derived status. Explicit columns, RLS-scoped client. */
export async function listDocuments(
  db: AgentDb,
  tenantId: string,
  page: number,
): Promise<{ items: KbDocumentRow[]; hasMore: boolean }> {
  const from = (page - 1) * KB_PAGE_SIZE;
  const { data, error } = await db
    .from("kb_documents")
    .select("id, title, source_type, created_at, created_by")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + KB_PAGE_SIZE);
  if (error) throw error;
  const all = (data ?? []) as { id: string; title: string; source_type: KbDocumentRow["sourceType"]; created_at: string; created_by?: string | null }[];
  const rows = all.slice(0, KB_PAGE_SIZE);

  const items = await Promise.all(
    rows.map(async (d) => {
      const [total, missing] = await Promise.all([
        db.from("kb_chunks").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("document_id", d.id),
        db
          .from("kb_chunks")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("document_id", d.id)
          .is("embedding", null),
      ]);
      if (total.error) throw total.error;
      if (missing.error) throw missing.error;
      const chunkCount = total.count ?? 0;
      return {
        id: d.id,
        title: d.title,
        sourceType: d.source_type,
        createdAt: d.created_at,
        createdBy: d.created_by ?? null,
        chunkCount,
        status: deriveDocStatus({ chunkCount, unembedded: missing.count ?? 0 }),
      };
    }),
  );
  return { items, hasMore: all.length > KB_PAGE_SIZE };
}
