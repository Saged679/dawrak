import type { ModelMessage } from "ai";
import type { AgentDb } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Return an existing conversation of this tenant+channel, or create one. A web conversation is bound to the
 * SHA-256 of the visitor's httpOnly cookie (`session_hash`): an id alone resumes nothing, and a conversation
 * with no owner (seeded or legacy rows) can never be resumed by id. An id of another tenant or session is
 * ignored, not reused (a new conversation is created instead).
 */
export async function getOrCreateConversation(
  db: AgentDb,
  p: { tenantId: string; channel: "web" | "whatsapp"; conversationId?: string; externalId?: string; sessionHash?: string | null },
): Promise<string> {
  if (p.conversationId && UUID_RE.test(p.conversationId)) {
    if (p.channel !== "web" || p.sessionHash) {
      let q = db
        .from("conversations")
        .select("id")
        .eq("id", p.conversationId)
        .eq("tenant_id", p.tenantId)
        .eq("channel", p.channel);
      if (p.channel === "web") q = q.eq("session_hash", p.sessionHash as string);
      const { data } = await q.maybeSingle();
      if (data) return (data as { id: string }).id;
    }
  }
  if (p.channel === "whatsapp" && p.externalId) {
    const { data } = await db
      .from("conversations")
      .select("id")
      .eq("tenant_id", p.tenantId)
      .eq("channel", "whatsapp")
      .eq("external_id", p.externalId)
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return (data as { id: string }).id;
  }
  const { data, error } = await db
    .from("conversations")
    .insert({
      tenant_id: p.tenantId,
      channel: p.channel,
      external_id: p.externalId ?? null,
      ...(p.channel === "web" && p.sessionHash ? { session_hash: p.sessionHash } : {}),
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("conversation_create_failed");
  return (data as { id: string }).id;
}

export async function saveMessage(
  db: AgentDb,
  p: { tenantId: string; conversationId: string; role: "user" | "assistant"; content: string; parts?: unknown },
): Promise<string | undefined> {
  const { data } = await db
    .from("messages")
    .insert({
      tenant_id: p.tenantId,
      conversation_id: p.conversationId,
      role: p.role,
      content: p.content,
      parts: p.parts ?? null,
    })
    .select("id")
    .single();
  await db
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", p.conversationId)
    .eq("tenant_id", p.tenantId);
  return (data as { id?: string } | null)?.id;
}

/** created_at (DATABASE clock) of one stored message of this conversation, or null. */
export async function messageCreatedAt(db: AgentDb, tenantId: string, conversationId: string, id: string): Promise<string | null> {
  const { data } = await db
    .from("messages")
    .select("created_at")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return (data as { created_at?: string } | null)?.created_at ?? null;
}

/** Last user/assistant turns as model messages (oldest first). */
export async function loadHistory(
  db: AgentDb,
  tenantId: string,
  conversationId: string,
  limit = 16,
): Promise<ModelMessage[]> {
  const { data } = await db
    .from("messages")
    .select("role, content")
    .eq("tenant_id", tenantId)
    .eq("conversation_id", conversationId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as { role: "user" | "assistant"; content: string }[])
    .reverse()
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
}

const MAX_VISITOR_MESSAGES = 120;

/**
 * What the SERVER knows about the visitor's side of this conversation, for the confirmation protocol and the
 * grounding of personal data: how many visitor messages exist (the current one is already stored by the
 * channel before the agent runs) and the typed ones. Voice notes count as messages but contribute no text
 * (their `parts` marks them as audio; the stored content is only a placeholder).
 */
export async function loadVisitorMessages(
  db: AgentDb,
  tenantId: string,
  conversationId: string,
): Promise<{ count: number; texts: string[]; latestCreatedAt: string | null }> {
  const { data, count } = await db
    .from("messages")
    .select("content, parts, created_at", { count: "exact" })
    .eq("tenant_id", tenantId)
    .eq("conversation_id", conversationId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(MAX_VISITOR_MESSAGES);
  const desc = (data ?? []) as { content: string; parts: { type?: string } | null; created_at?: string }[];
  const latestCreatedAt = desc[0]?.created_at ?? null; // newest first
  const rows = [...desc].reverse();
  return {
    latestCreatedAt,
    count: typeof count === "number" ? count : rows.length,
    texts: rows.filter((r) => r.parts?.type !== "audio").map((r) => r.content),
  };
}
