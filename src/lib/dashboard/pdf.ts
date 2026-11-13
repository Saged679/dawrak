import { MAX_DOC_CHARS } from "@/lib/agent/knowledge";
import { MAX_PDF_BYTES, MAX_PDF_PAGES, PDF_PARSE_TIMEOUT_MS } from "./knowledge-limits";

export { MAX_PDF_BYTES, MAX_PDF_PAGES };

/** A PDF starts with "%PDF-". The extension and the browser-supplied type are never trusted. */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}

export type PdfCheck = { ok: true } | { ok: false; code: "not_pdf" | "too_large" | "empty" };

export function checkPdfUpload(bytes: Uint8Array): PdfCheck {
  if (bytes.length === 0) return { ok: false, code: "empty" };
  if (bytes.length > MAX_PDF_BYTES) return { ok: false, code: "too_large" };
  if (!hasPdfMagic(bytes)) return { ok: false, code: "not_pdf" };
  return { ok: true };
}

export type PdfText =
  | { ok: true; text: string; pages: number }
  | { ok: false; code: "no_text" | "pdf_unreadable" };

/** The slice of the pdf.js document proxy this module uses (also what tests fake). */
export type PdfDocLike = {
  numPages: number;
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: ReadonlyArray<object> }>;
  }>;
  destroy?: () => Promise<void> | void;
};

export type ExtractOptions = {
  timeoutMs?: number;
  /** Test seam: replaces the real pdf.js loader. */
  loadPdf?: (bytes: Uint8Array) => Promise<PdfDocLike>;
};

async function loadWithPdfJs(bytes: Uint8Array): Promise<PdfDocLike> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  return {
    numPages: doc.numPages,
    getPage: (n) => doc.getPage(n),
    destroy: () => doc.loadingTask.destroy(), // frees the parser (and aborts work in flight)
  };
}

class ParseTimeout extends Error {}

/**
 * Server-side text extraction (unpdf = serverless pdf.js build, no native code). Hardened against
 * hostile input: the whole parse is abandoned after PDF_PARSE_TIMEOUT_MS, the page count is checked
 * before any text is read, and pages are read one at a time, stopping once MAX_DOC_CHARS is reached
 * (the rest could never be stored anyway).
 */
export async function extractPdfText(bytes: Uint8Array, opts: ExtractOptions = {}): Promise<PdfText> {
  const timeoutMs = opts.timeoutMs ?? PDF_PARSE_TIMEOUT_MS;
  let doc: PdfDocLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const work = (async (): Promise<PdfText> => {
    doc = await (opts.loadPdf ?? loadWithPdfJs)(bytes);
    if (cancelled) throw new ParseTimeout();
    if (doc.numPages > MAX_PDF_PAGES) return { ok: false, code: "pdf_unreadable" };
    let text = "";
    let pages = 0;
    for (let n = 1; n <= doc.numPages && text.length <= MAX_DOC_CHARS; n++) {
      if (cancelled) throw new ParseTimeout();
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages = n;
      for (const raw of content.items) {
        const it = raw as { str?: unknown; hasEOL?: unknown }; // marked-content entries carry no text
        text += (typeof it.str === "string" ? it.str : "") + (it.hasEOL ? "\n" : "");
      }
      text += "\n";
    }
    // A scanned PDF has no text layer: nothing, or only whitespace, comes back.
    if (!/[\p{L}\p{N}]/u.test(text)) return { ok: false, code: "no_text" };
    return { ok: true, text, pages };
  })();

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cancelled = true;
      reject(new ParseTimeout());
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, timeout]);
  } catch {
    work.catch(() => {}); // the abandoned parse must not raise an unhandled rejection later
    return { ok: false, code: "pdf_unreadable" };
  } finally {
    clearTimeout(timer);
    try {
      void Promise.resolve((doc as PdfDocLike | null)?.destroy?.()).catch(() => {});
    } catch {
      /* best effort */
    }
  }
}
