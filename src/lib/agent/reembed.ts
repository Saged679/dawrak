import { EMBEDDING_DIMENSIONS, embedTexts, type Embedder } from "./knowledge";
import type { AgentDb } from "./types";

export const REEMBED_LIMIT = 24;

export type ReembedResult = {
  embedded: number;
  /** why nothing (more) was embedded; absent when the run completed */
  skipped?: "no_key" | "quota" | "error" | "nothing_to_do";
};

type Row = { id: string; tenant_id: string; content: string };

const toPgVector = (v: number[]) => `[${v.join(",")}]`;

function isQuota(e: unknown, depth = 0): boolean {
  const x = e as { statusCode?: number; status?: number; lastError?: unknown; cause?: unknown } | null;
  if (!x || depth > 3) return false;
  if (x.statusCode === 429 || x.status === 429) return true;
  return isQuota(x.lastError ?? x.cause, depth + 1);
}

/**
 * Best-effort background step (called from the 30-minute cron): finds chunks whose embedding is NULL (the
 * ones reset_demo() seeds, or a failed dashboard indexing), embeds up to `limit` of them, demo tenants first,
 * and writes ONLY the `embedding` column. Skips silently without a Gemini key or on quota errors, never
 * throws, never logs chunk text (only counts and an error class).
 */
export async function reembedMissing(
  db: AgentDb,
  opts: { limit?: number; embedder?: Embedder; hasKey?: boolean } = {},
): Promise<ReembedResult> {
  const limit = opts.limit ?? REEMBED_LIMIT;
  const embedder = opts.embedder ?? embedTexts;
  const hasKey = opts.hasKey ?? Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  if (!opts.embedder && !hasKey) return { embedded: 0, skipped: "no_key" };

  try {
    const rows: Row[] = [];
    const { data: demos, error: dErr } = await db.from("tenants").select("id").eq("is_demo", true).limit(50);
    if (dErr) throw dErr;
    const demoIds = ((demos ?? []) as { id: string }[]).map((t) => t.id);
    if (demoIds.length > 0) {
      const { data, error } = await db
        .from("kb_chunks")
        .select("id, tenant_id, content")
        .is("embedding", null)
        .in("tenant_id", demoIds)
        .limit(limit);
      if (error) throw error;
      rows.push(...((data ?? []) as Row[]));
    }
    if (rows.length < limit) {
      let q = db.from("kb_chunks").select("id, tenant_id, content").is("embedding", null);
      if (demoIds.length > 0) q = q.not("tenant_id", "in", `(${demoIds.join(",")})`);
      const { data, error } = await q.limit(limit - rows.length);
      if (error) throw error;
      rows.push(...((data ?? []) as Row[]));
    }
    if (rows.length === 0) return { embedded: 0, skipped: "nothing_to_do" };

    const vectors = await embedder(rows.map((r) => r.content));
    if (vectors.length !== rows.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      console.error("cron_reembed_error", "shape_mismatch");
      return { embedded: 0, skipped: "error" };
    }
    let embedded = 0;
    for (let i = 0; i < rows.length; i++) {
      const { error } = await db
        .from("kb_chunks")
        .update({ embedding: toPgVector(vectors[i]) })
        .eq("id", rows[i].id)
        .eq("tenant_id", rows[i].tenant_id)
        .is("embedding", null); // never overwrite an embedding written meanwhile
      if (!error) embedded++;
    }
    return { embedded };
  } catch (e) {
    if (isQuota(e)) return { embedded: 0, skipped: "quota" };
    console.error("cron_reembed_error", (e as { code?: string; name?: string } | null)?.code ?? (e as Error | null)?.name ?? "unknown");
    return { embedded: 0, skipped: "error" };
  }
}
