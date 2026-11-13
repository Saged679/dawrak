import { NextResponse } from "next/server";
import { canManageKnowledge } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/auth/supabase";
import { checkKbWriteLimit } from "@/lib/dashboard/kb-rate-limit";
import { createDocument, type KbResult } from "@/lib/dashboard/knowledge";
import { MAX_PDF_BYTES } from "@/lib/dashboard/knowledge-limits";
import { checkPdfUpload, extractPdfText } from "@/lib/dashboard/pdf";

export const runtime = "nodejs";
export const maxDuration = 60;

const json = (body: KbResult<object>, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/**
 * CSRF guard for this mutating POST (the session cookie is also SameSite=Lax). An Origin header
 * must parse and match our host ("null" and malformed values are rejected, never thrown on); with no
 * Origin, the browser must say Sec-Fetch-Site: same-origin or same-site. Neither header = refused.
 */
function isSameSiteRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    try {
      const host = req.headers.get("host") ?? new URL(req.url).host;
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = req.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "same-site";
}

/**
 * PDF upload for the knowledge base (a route handler, not a server action: server actions cap the
 * body at 1 MB). The session decides tenant and role; the file is verified by its magic bytes,
 * its text is extracted on the server and indexed like any other document.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return json({ ok: false, code: "forbidden" }, 401);
  if (!canManageKnowledge(session.role)) return json({ ok: false, code: "forbidden" }, 403);

  if (!isSameSiteRequest(req)) return json({ ok: false, code: "forbidden" }, 403);

  const limited = await checkKbWriteLimit(session);
  if (limited) return json({ ok: false, code: limited }, limited === "write_limit" ? 429 : 500);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_PDF_BYTES + 64 * 1024) return json({ ok: false, code: "too_large" }, 413);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ ok: false, code: "invalid" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return json({ ok: false, code: "invalid" }, 400);
  if (file.size > MAX_PDF_BYTES) return json({ ok: false, code: "too_large" }, 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkPdfUpload(bytes);
  if (!check.ok) return json({ ok: false, code: check.code }, check.code === "too_large" ? 413 : 400);

  const extracted = await extractPdfText(bytes);
  if (!extracted.ok) return json({ ok: false, code: extracted.code }, 422);

  const rawTitle = form.get("title");
  const fallback = file.name.replace(/\.pdf$/i, "");
  const title = (typeof rawTitle === "string" && rawTitle.trim()) || fallback || "PDF";

  const db = await createSupabaseServerClient();
  const result = await createDocument(db, session, { title, content: extracted.text, sourceType: "pdf" });
  return json(result);
}
