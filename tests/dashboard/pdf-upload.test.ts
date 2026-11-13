import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: null as unknown,
  created: [] as unknown[],
  limiter: [] as string[],
  allow: true,
}));

vi.mock("@/lib/db/public", () => ({
  rateLimitOk: async (key: string) => {
    state.limiter.push(key);
    return state.allow;
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: async () => state.session }));
vi.mock("@/lib/auth/supabase", () => ({ createSupabaseServerClient: async () => ({}) }));
vi.mock("@/lib/dashboard/knowledge", async (orig) => ({
  ...(await orig<typeof import("@/lib/dashboard/knowledge")>()),
  createDocument: async (...args: unknown[]) => {
    state.created.push(args[2]);
    return { ok: true, documentId: "d", chunks: 1, truncated: false };
  },
}));

import { POST } from "@/app/api/dashboard/knowledge/pdf/route";
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from "@/lib/dashboard/knowledge-limits";
import { checkPdfUpload, extractPdfText, hasPdfMagic } from "@/lib/dashboard/pdf";

/** Builds a tiny valid PDF. With `text` empty the page has no text layer (like a scan). */
function buildPdf(text: string): Uint8Array {
  const stream = text ? `BT /F1 18 Tf 20 100 Td (${text}) Tj ET` : "0 0 m 10 10 l S";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("PDF checks", () => {
  it("accepts only bytes that start with %PDF-", () => {
    expect(hasPdfMagic(buildPdf("hi"))).toBe(true);
    expect(hasPdfMagic(PNG)).toBe(false);
    expect(hasPdfMagic(new TextEncoder().encode("<html>%PDF-</html>"))).toBe(false);
    expect(hasPdfMagic(new Uint8Array())).toBe(false);
  });
  it("rejects wrong content, empty and oversized files", () => {
    expect(checkPdfUpload(PNG)).toEqual({ ok: false, code: "not_pdf" });
    expect(checkPdfUpload(new Uint8Array())).toEqual({ ok: false, code: "empty" });
    const big = new Uint8Array(MAX_PDF_BYTES + 1);
    big.set(buildPdf("x").slice(0, 8));
    expect(checkPdfUpload(big)).toEqual({ ok: false, code: "too_large" });
    expect(checkPdfUpload(buildPdf("hi"))).toEqual({ ok: true });
  });
});

describe("PDF text extraction (real pdf.js, no network)", () => {
  it("extracts the text layer", async () => {
    const r = await extractPdfText(buildPdf("Opening hours nine to five"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("Opening hours");
  });
  it("reports a PDF without a text layer as no_text", async () => {
    expect(await extractPdfText(buildPdf(""))).toEqual({ ok: false, code: "no_text" });
  });
  it("reports damaged input as pdf_unreadable", async () => {
    expect(await extractPdfText(new TextEncoder().encode("%PDF-1.4 garbage"))).toEqual({
      ok: false,
      code: "pdf_unreadable",
    });
  });
});

function upload(bytes: Uint8Array, name = "faq.pdf", type = "application/pdf", headers: Record<string, string> = {}) {
  const body = new FormData();
  body.set("file", new File([bytes as BlobPart], name, { type }));
  // a same-origin browser POST always carries Origin; tests override or drop it explicitly
  return new Request("http://localhost/api/dashboard/knowledge/pdf", {
    method: "POST",
    body,
    headers: { origin: "http://localhost", host: "localhost", ...headers },
  });
}
const asRole = (role: string) => (state.session = { role, userId: "u1", tenant: { id: "t1", is_demo: false } });

describe("POST /api/dashboard/knowledge/pdf", () => {
  beforeEach(() => {
    state.session = null;
    state.created = [];
    state.limiter = [];
    state.allow = true;
  });

  it("requires a session", async () => {
    expect((await POST(upload(buildPdf("hi")))).status).toBe(401);
  });
  it("is owner only", async () => {
    for (const role of ["receptionist", "provider"]) {
      asRole(role);
      expect((await POST(upload(buildPdf("hi")))).status).toBe(403);
    }
    expect(state.created).toHaveLength(0);
  });
  it("rejects a non-PDF even when it is named .pdf and typed application/pdf", async () => {
    asRole("owner");
    const res = await POST(upload(PNG, "evil.pdf", "application/pdf"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, code: "not_pdf" });
    expect(state.created).toHaveLength(0);
  });
  it("rejects files over 4 MB", async () => {
    asRole("owner");
    const big = new Uint8Array(MAX_PDF_BYTES + 10);
    big.set(buildPdf("x").slice(0, 8));
    const res = await POST(upload(big));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("too_large");
  });
  it("rejects a cross-origin request", async () => {
    asRole("owner");
    const res = await POST(upload(buildPdf("hi"), "a.pdf", "application/pdf", { origin: "https://evil.example", host: "localhost" }));
    expect(res.status).toBe(403);
  });
  describe("origin check (L5)", () => {
    const post = (headers: Record<string, string | undefined>) => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
      const body = new FormData();
      body.set("file", new File([buildPdf("Parking is free") as BlobPart], "a.pdf", { type: "application/pdf" }));
      return new Request("http://localhost/api/dashboard/knowledge/pdf", { method: "POST", body, headers: h });
    };
    it.each(["null", "not a url", "://x", "https://", "http://evil.example"])("Origin %s is a clean 403, not an exception", async (origin) => {
      asRole("owner");
      const res = await POST(post({ origin, host: "localhost" }));
      expect(res.status).toBe(403);
      expect(state.created).toHaveLength(0);
    });
    it("no Origin and no Sec-Fetch-Site is refused", async () => {
      asRole("owner");
      expect((await POST(post({ host: "localhost" }))).status).toBe(403);
    });
    it("a cross-site Sec-Fetch-Site without Origin is refused; same-origin and same-site pass", async () => {
      asRole("owner");
      expect((await POST(post({ host: "localhost", "sec-fetch-site": "cross-site" }))).status).toBe(403);
      expect((await POST(post({ host: "localhost", "sec-fetch-site": "none" }))).status).toBe(403);
      expect((await POST(post({ host: "localhost", "sec-fetch-site": "same-origin" }))).status).toBe(200);
      expect((await POST(post({ host: "localhost", "sec-fetch-site": "same-site" }))).status).toBe(200);
    });
  });

  describe("write rate limit (M3)", () => {
    it("counts the upload per user and per tenant", async () => {
      asRole("owner");
      expect((await POST(upload(buildPdf("hi there")))).status).toBe(200);
      expect(state.limiter).toEqual(["user:u1:kb:write", "tenant:t1:kb:write:day"]);
    });
    it("answers 429 with a localisable code and writes nothing when over the limit", async () => {
      asRole("owner");
      state.allow = false;
      const res = await POST(upload(buildPdf("hi there")));
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ ok: false, code: "write_limit" });
      expect(state.created).toHaveLength(0);
    });
  });

  it("tells the owner when a PDF has no readable text", async () => {
    asRole("owner");
    const res = await POST(upload(buildPdf("")));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("no_text");
  });
  it("creates a pdf document from the extracted text", async () => {
    asRole("owner");
    const res = await POST(upload(buildPdf("Parking is free")));
    expect((await res.json()).ok).toBe(true);
    expect(state.created[0]).toMatchObject({ title: "faq", sourceType: "pdf" });
    expect((state.created[0] as { content: string }).content).toContain("Parking is free");
  });
});

/** A valid PDF with `pageCount` pages, each carrying `perPage` characters of text. */
function buildManyPagePdf(pageCount: number, perPage = 10): Uint8Array {
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
  ];
  const fontObj = 3 + pageCount * 2;
  for (let i = 0; i < pageCount; i++) {
    const stream = `BT /F1 8 Tf 10 100 Td (${"word ".repeat(Math.ceil(perPage / 5)).slice(0, perPage)}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 30000 200] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

describe("PDF parsing safeguards (L2)", () => {
  it("the size cap is 4 MB", () => {
    expect(MAX_PDF_BYTES).toBe(4 * 1024 * 1024);
  });

  it("refuses a PDF with more than MAX_PDF_PAGES pages without reading any page text", async () => {
    const getPage = vi.fn();
    const r = await extractPdfText(buildManyPagePdf(3), {
      loadPdf: async () => ({ numPages: MAX_PDF_PAGES + 1, getPage }),
    });
    expect(r).toEqual({ ok: false, code: "pdf_unreadable" });
    expect(getPage).not.toHaveBeenCalled();
    // and a real crafted many-page PDF is refused too
    expect(await extractPdfText(buildManyPagePdf(MAX_PDF_PAGES + 50))).toEqual({ ok: false, code: "pdf_unreadable" });
  });

  it("reads page by page and stops once MAX_DOC_CHARS is reached", async () => {
    const { getDocumentProxy } = await import("unpdf");
    const pagesRead: number[] = [];
    // 100 pages of ~4,000 characters each: the cap (60,000) is reached after about 16 pages
    const r = await extractPdfText(buildManyPagePdf(100, 4000), {
      loadPdf: async (b) => {
        const real = await getDocumentProxy(new Uint8Array(b));
        return {
          numPages: real.numPages,
          getPage: (n: number) => (pagesRead.push(n), real.getPage(n)),
          destroy: () => real.loadingTask.destroy(),
        } as never;
      },
    });
    expect(r.ok).toBe(true);
    expect(pagesRead.length).toBeGreaterThan(0);
    expect(pagesRead.length).toBeLessThan(40);
    if (r.ok) expect(r.text.length).toBeGreaterThan(60_000);
  });

  it("abandons a parse that hangs, cleanly (no throw, no unhandled rejection)", async () => {
    let release: () => void = () => {};
    const hung = new Promise<never>((_, reject) => (release = () => reject(new Error("late"))));
    const started = Date.now();
    const r = await extractPdfText(buildPdf("hi"), { timeoutMs: 50, loadPdf: () => hung });
    expect(r).toEqual({ ok: false, code: "pdf_unreadable" });
    expect(Date.now() - started).toBeLessThan(2000);
    release(); // the abandoned work rejects later: must not surface
    await new Promise((res) => setTimeout(res, 20));
  });

  it("times out in the middle of a slow page loop and destroys the document", async () => {
    const destroy = vi.fn();
    const r = await extractPdfText(buildPdf("hi"), {
      timeoutMs: 50,
      loadPdf: async () => ({ numPages: 3, getPage: () => new Promise(() => {}), destroy }),
    });
    expect(r).toEqual({ ok: false, code: "pdf_unreadable" });
    expect(destroy).toHaveBeenCalled();
  });
});
