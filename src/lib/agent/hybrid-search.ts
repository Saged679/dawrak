import { lexicalSearch } from "./lexical";
import type { AgentDb } from "./types";

/**
 * Hybrid knowledge search: semantic and lexical together, merged with reciprocal rank fusion.
 *
 * Why: with only SOME of a tenant's chunks embedded, one irrelevant semantic hit used to skip the lexical
 * fallback, so "ما هي ساعات العمل؟" answered "no information" although a chunk holds the hours. The lexical
 * path now runs whenever (a) the tenant has ANY chunk without an embedding, (b) the best semantic score is
 * weak, or (c) the semantic search returned nothing / failed.
 */

/** Below this cosine similarity a semantic hit is treated as noise. 0.3 let unrelated chunks through. */
export const MIN_SEMANTIC_SIMILARITY = 0.45;
/** A semantic top score under this is "weak": the lexical search runs as well. */
export const WEAK_SEMANTIC_SIMILARITY = 0.6;
const LEXICAL_MAX_CHUNKS = 500;
const RRF_K = 60;
const TOP = 4;

export type KnowledgeHit = {
  content: string;
  source: "semantic" | "lexical" | "both";
  /** reciprocal-rank-fusion score normalised to 0..1 (1 = first in every list that found it) */
  score: number;
  similarity?: number;
};

type Sem = { id: string; content: string; similarity: number };

/** Pure fusion step (exported for tests). */
export function fuse(semantic: Sem[], lexical: { id: string; content: string; score: number }[], top = TOP): KnowledgeHit[] {
  const byId = new Map<string, { content: string; rrf: number; sem?: Sem; lex: boolean }>();
  semantic.forEach((r, i) => {
    byId.set(r.id, { content: r.content, rrf: 1 / (RRF_K + i + 1), sem: r, lex: false });
  });
  lexical.forEach((r, i) => {
    const cur = byId.get(r.id);
    const add = 1 / (RRF_K + i + 1);
    if (cur) {
      cur.rrf += add;
      cur.lex = true;
    } else byId.set(r.id, { content: r.content, rrf: add, lex: true });
  });
  const max = (semantic.length > 0 ? 1 : 0) / (RRF_K + 1) + (lexical.length > 0 ? 1 : 0) / (RRF_K + 1) || 1;
  return [...byId.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, top)
    .map((h) => ({
      content: h.content,
      source: h.sem && h.lex ? ("both" as const) : h.sem ? ("semantic" as const) : ("lexical" as const),
      score: Number(Math.min(1, h.rrf / max).toFixed(3)),
      ...(h.sem ? { similarity: Number(h.sem.similarity.toFixed(3)) } : {}),
    }));
}

export async function hybridSearch(
  db: AgentDb,
  tenantId: string,
  query: string,
  embedQuery: (text: string) => Promise<number[]>,
  /** Demo tenants: SHA-256 of the visitor's session. The database returns seeded chunks plus this visitor's own only. */
  sessionHash: string | null = null,
): Promise<{ hits: KnowledgeHit[]; semanticAvailable: boolean; lexicalRan: boolean }> {
  // 1) semantic
  let semantic: Sem[] = [];
  let semanticAvailable = true;
  try {
    const embedding = await embedQuery(query);
    const { data, error } = await db.rpc("match_kb_chunks", {
      p_tenant_id: tenantId,
      p_embedding: `[${embedding.join(",")}]`,
      p_k: 6,
      p_session_hash: sessionHash,
    });
    if (error) throw error;
    semantic = ((data ?? []) as Sem[]).filter((r) => r.similarity >= MIN_SEMANTIC_SIMILARITY);
  } catch {
    semanticAvailable = false; // embedding quota/failure or a DB hiccup: the lexical search still works
  }

  // 2) is the lexical search needed?
  const top = semantic.reduce((m, r) => Math.max(m, r.similarity), 0);
  let needLexical = !semanticAvailable || semantic.length === 0 || top < WEAK_SEMANTIC_SIMILARITY;
  if (!needLexical) {
    const { data } = await db.rpc("kb_search_chunks", { p_tenant_id: tenantId, p_session_hash: sessionHash, p_limit: LEXICAL_MAX_CHUNKS });
    needLexical = ((data ?? []) as { embedded: boolean }[]).some((c) => !c.embedded);
  }

  let lexical: { id: string; content: string; score: number }[] = [];
  if (needLexical) {
    // kb_search_chunks applies the demo visibility rule (seeded + this visitor's chunks) inside the database
    const { data: chunks, error } = await db.rpc("kb_search_chunks", {
      p_tenant_id: tenantId,
      p_session_hash: sessionHash,
      p_limit: LEXICAL_MAX_CHUNKS,
    });
    if (error) throw error;
    lexical = lexicalSearch((chunks ?? []) as { id: string; content: string }[], query);
  }
  return { hits: fuse(semantic, lexical), semanticAvailable, lexicalRan: needLexical };
}
