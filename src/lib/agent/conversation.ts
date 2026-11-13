import type { ModelMessage } from "ai";
import type { AgentDb } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Return an existing conversation of this tenant+channel, or create one. The (unguessable) uuid
 * acts as the web session secret; a uuid belonging to another tenant is ignored, not reused.
 */
export async function getOrCreateConversation(
  db: AgentDb,
  p: { tenantId: string; channel: "web" | "whatsapp"; conversationId?: string; externalId?: string },
): Promise<string> {
  if (p.conversationId && UUID_RE.test(p.conversationId)) {
    const { data } = await db
      .from("conversations")
      .select("id")
      .eq("id", p.conversationId)
      .eq("tenant_id", p.tenantId)
      .eq("channel", p.channel)
      .maybeSingle();
    if (data) return (data as { id: string }).id;
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
    .insert({ tenant_id: p.tenantId, channel: p.channel, external_id: p.externalId ?? null })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("conversation_create_failed");
  return (data as { id: string }).id;
}

export async function saveMessage(
  db: AgentDb,
  p: { tenantId: string; conversationId: string; role: "user" | "assistant"; content: string; parts?: unknown },
) {
  await db.from("messages").insert({
    tenant_id: p.tenantId,
    conversation_id: p.conversationId,
    role: p.role,
    content: p.content,
    parts: p.parts ?? null,
  });
  await db
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", p.conversationId)
    .eq("tenant_id", p.tenantId);
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
