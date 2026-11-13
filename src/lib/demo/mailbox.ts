import "server-only";
import { getServiceClient } from "@/lib/db/client";
import { linkPartsFor } from "./links";

export type MailboxMessage = { id: string; subject: string; to: string; body: string; createdAt: string };

/** The visitor's own mails, newest first. The session hash is the only key: no hash, no rows. */
export async function listMailbox(sessionHash: string, limit = 20): Promise<MailboxMessage[]> {
  if (!/^[0-9a-f]{64}$/.test(sessionHash)) return [];
  const { data, error } = await getServiceClient()
    .from("demo_outbox")
    .select("id, subject, to_email, body_text, created_at")
    .eq("session_hash", sessionHash)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as { id: string; subject: string; to_email: string; body_text: string; created_at: string }[]).map(
    (r) => ({ id: r.id, subject: r.subject, to: r.to_email, body: r.body_text, createdAt: r.created_at }),
  );
}

/** Splits mail text into plain parts and links to OUR OWN site only (any other URL stays inert text). */
export function splitLinks(body: string) {
  return linkPartsFor(body, process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000");
}
