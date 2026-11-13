"use server";

import { canManageKnowledge } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { checkKbWriteLimit } from "@/lib/dashboard/kb-rate-limit";
import {
  createDocument,
  deleteDocument,
  faqInput,
  idInput,
  reindexDocument,
  textInput,
  type KbResult,
} from "@/lib/dashboard/knowledge";

type Added = KbResult<{ documentId: string; chunks: number; truncated: boolean }>;

/** Every action derives tenant and role from the session; nothing tenant-related comes from the client. */
async function owner() {
  const session = await getSession();
  return session && canManageKnowledge(session.role) ? session : null;
}

export async function addFaq(input: unknown): Promise<Added> {
  const parsed = faqInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const session = await owner();
  if (!session) return { ok: false, code: "forbidden" };
  const limited = await checkKbWriteLimit(session);
  if (limited) return { ok: false, code: limited };
  const { question, answer } = parsed.data;
  return createDocument(await createSupabaseServerClient(), session, {
    title: question,
    content: `${question}\n${answer}`,
    sourceType: "faq",
  });
}

export async function addText(input: unknown): Promise<Added> {
  const parsed = textInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const session = await owner();
  if (!session) return { ok: false, code: "forbidden" };
  const limited = await checkKbWriteLimit(session);
  if (limited) return { ok: false, code: limited };
  return createDocument(await createSupabaseServerClient(), session, {
    title: parsed.data.title,
    content: parsed.data.content,
    sourceType: "text",
  });
}

export async function removeDocument(input: unknown): Promise<KbResult> {
  const parsed = idInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const session = await owner();
  if (!session) return { ok: false, code: "forbidden" };
  return deleteDocument(await createSupabaseServerClient(), session, parsed.data.id);
}

export async function reindex(input: unknown): Promise<KbResult<{ chunks: number }>> {
  const parsed = idInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  const session = await owner();
  if (!session) return { ok: false, code: "forbidden" };
  const limited = await checkKbWriteLimit(session);
  if (limited) return { ok: false, code: limited };
  return reindexDocument(await createSupabaseServerClient(), session, parsed.data.id);
}
