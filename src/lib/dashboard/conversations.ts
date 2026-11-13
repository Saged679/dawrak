import "server-only";
import { voiceInfo, type VoiceInfo } from "./voice-info";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import type { AppointmentStatus } from "@/lib/auth/roles";
import type { SessionContext } from "@/lib/auth/session";

export const CONVERSATION_PAGE_SIZE = 20;
export const MESSAGE_PAGE_SIZE = 100;

export { voiceInfo, type VoiceInfo };

type Named = { name_ar: string; name_en: string | null };
const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export type ConversationRow = {
  id: string;
  channel: string;
  startedAt: string;
  lastMessageAt: string;
  customer: { full_name: string; phone: string } | null;
  last: { role: string; content: string; voice: VoiceInfo | null } | null;
};

/**
 * One page of the tenant's assistant conversations, newest first. Authenticated (RLS) client:
 * the policies only let owner and receptionist read these tables. Explicit columns only.
 */
export async function listConversations(
  session: SessionContext,
  page: number,
): Promise<{ items: ConversationRow[]; hasMore: boolean }> {
  const supabase = await createSupabaseServerClient();
  const from = (page - 1) * CONVERSATION_PAGE_SIZE;
  const { data, error } = await supabase
    .from("conversations")
    .select("id, channel, started_at, last_message_at, customers(full_name, phone)")
    .eq("tenant_id", session.tenant.id)
    .order("last_message_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + CONVERSATION_PAGE_SIZE);
  if (error) throw error;
  type Raw = {
    id: string;
    channel: string;
    started_at: string;
    last_message_at: string;
    customers: { full_name: string; phone: string } | { full_name: string; phone: string }[] | null;
  };
  const all = (data ?? []) as unknown as Raw[];
  const rows = all.slice(0, CONVERSATION_PAGE_SIZE);

  const items = await Promise.all(
    rows.map(async (c): Promise<ConversationRow> => {
      const { data: m } = await supabase
        .from("messages")
        .select("role, content, parts")
        .eq("tenant_id", session.tenant.id)
        .eq("conversation_id", c.id)
        .in("role", ["user", "assistant"])
        .order("created_at", { ascending: false })
        .limit(1);
      const lastRaw = ((m ?? []) as { role: string; content: string; parts?: unknown }[])[0];
      const last = lastRaw ? { role: lastRaw.role, content: lastRaw.content, voice: voiceInfo(lastRaw.parts) } : null;
      return {
        id: c.id,
        channel: c.channel,
        startedAt: c.started_at,
        lastMessageAt: c.last_message_at,
        customer: one(c.customers),
        last,
      };
    }),
  );
  return { items, hasMore: all.length > CONVERSATION_PAGE_SIZE };
}

export type ThreadMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  voice: VoiceInfo | null;
};

export type LinkedAppointment = {
  id: string;
  startsAt: string;
  status: AppointmentStatus;
  service: Named;
  provider: Named;
};

export type ConversationThread = {
  conversation: Omit<ConversationRow, "last">;
  messages: ThreadMessage[];
  hasMore: boolean;
  appointments: LinkedAppointment[];
};

/**
 * One conversation with a page of its messages (oldest first). The schema stores no link between a
 * message and an appointment, so "booked by the assistant" is matched: appointments created with
 * source `chat` for the same customer while the conversation was active (plus a few minutes).
 */
export async function getThread(
  session: SessionContext,
  id: string,
  page: number,
): Promise<ConversationThread | null> {
  const supabase = await createSupabaseServerClient();
  const tenantId = session.tenant.id;
  const { data: c, error } = await supabase
    .from("conversations")
    .select("id, channel, customer_id, started_at, last_message_at, customers(full_name, phone)")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!c) return null;
  const conv = c as unknown as {
    id: string;
    channel: string;
    customer_id: string | null;
    started_at: string;
    last_message_at: string;
    customers: { full_name: string; phone: string } | { full_name: string; phone: string }[] | null;
  };

  const from = (page - 1) * MESSAGE_PAGE_SIZE;
  const { data: msgs, error: mErr } = await supabase
    .from("messages")
    .select("id, role, content, parts, created_at")
    .eq("tenant_id", tenantId)
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(from, from + MESSAGE_PAGE_SIZE);
  if (mErr) throw mErr;
  const raw = (msgs ?? []) as {
    id: string;
    role: ThreadMessage["role"];
    content: string;
    parts?: unknown;
    created_at: string;
  }[];

  let appointments: LinkedAppointment[] = [];
  if (conv.customer_id) {
    const lo = new Date(new Date(conv.started_at).getTime() - 60_000).toISOString();
    const hi = new Date(new Date(conv.last_message_at).getTime() + 5 * 60_000).toISOString();
    const { data: appts, error: aErr } = await supabase
      .from("appointments")
      .select("id, starts_at, status, services(name_ar, name_en), providers(name_ar, name_en)")
      .eq("tenant_id", tenantId)
      .eq("customer_id", conv.customer_id)
      .eq("source", "chat")
      .gte("created_at", lo)
      .lte("created_at", hi)
      .order("created_at", { ascending: true })
      .limit(10);
    if (aErr) throw aErr;
    type RawA = {
      id: string;
      starts_at: string;
      status: AppointmentStatus;
      services: Named | Named[] | null;
      providers: Named | Named[] | null;
    };
    appointments = ((appts ?? []) as unknown as RawA[]).map((a) => ({
      id: a.id,
      startsAt: a.starts_at,
      status: a.status,
      service: one(a.services) ?? { name_ar: "", name_en: null },
      provider: one(a.providers) ?? { name_ar: "", name_en: null },
    }));
  }

  return {
    conversation: {
      id: conv.id,
      channel: conv.channel,
      startedAt: conv.started_at,
      lastMessageAt: conv.last_message_at,
      customer: one(conv.customers),
    },
    messages: raw
      .slice(0, MESSAGE_PAGE_SIZE)
      .map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.created_at, voice: voiceInfo(m.parts) })),
    hasMore: raw.length > MESSAGE_PAGE_SIZE,
    appointments,
  };
}
