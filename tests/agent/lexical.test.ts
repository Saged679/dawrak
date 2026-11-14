import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { lexicalSearch, normalizeText, tokenize } from "@/lib/agent/lexical";
import { createTools } from "@/lib/agent/tools";
import type { AgentDb, ToolContext } from "@/lib/agent/types";
import { CONV, TENANT, fakeDb } from "./helpers";

const ch = (id: string, content: string) => ({ id, content });

describe("normalizeText", () => {
  it("strips diacritics and tatweel, unifies alef/ya/ta marbuta, lowercases, drops punctuation", () => {
    expect(normalizeText("السَّاعَاتُ")).toBe("الساعات");
    expect(normalizeText("مـــواعيد")).toBe("مواعيد");
    expect(normalizeText("أحمد إبراهيم آمن")).toBe("احمد ابراهيم امن");
    expect(normalizeText("مستشفى")).toBe("مستشفي");
    expect(normalizeText("عيادة")).toBe("عياده");
    expect(normalizeText("Opening HOURS!!  (Sun-Thu)")).toBe("opening hours sun thu");
    expect(normalizeText("الساعة ٩ و ۱۰")).toBe("الساعه 9 و 10");
  });
});

describe("tokenize", () => {
  it("removes stopwords (ar/en) and proclitics", () => {
    expect(tokenize("ما هي ساعات العمل؟")).toEqual(["ساعات", "عمل"]);
    expect(tokenize("What are your opening hours?")).toEqual(["opening", "hour"]);
    expect(tokenize("والعيادة")).toEqual(["عياده"]);
  });
});

const KB = [
  ch("hours", "ساعات العمل: من الأحد إلى الخميس، من 9 صباحاً إلى 1 ظهراً ومن 4 عصراً إلى 9 مساءً. الجمعة والسبت إجازة."),
  ch("deposit", "العربون 50 ريال يُخصم من قيمة الخدمة، ويُلغى الحجز تلقائياً إذا لم يتم الدفع خلال 15 دقيقة."),
  ch("insurance", "نقبل التأمين الطبي من عدة شركات، يرجى إحضار البطاقة عند الحضور."),
  ch("en-parking", "Free parking is available behind the building. Enter from the side street."),
  ch("en-cancel", "You can cancel for free up to 24 hours before your appointment."),
];

describe("lexicalSearch", () => {
  it("finds the hours chunk for the Arabic question, with or without diacritics and alef variants", () => {
    for (const q of ["ما هي ساعات العمل؟", "ساعَات العَمَل", "اوقات الدوام", "ماهي ساعات العمل عندكم"]) {
      expect(lexicalSearch(KB, q)[0]?.id, q).toBe("hours");
    }
  });
  it("alef/ya/ta marbuta variants match", () => {
    expect(lexicalSearch(KB, "التامين الطبي")[0]?.id).toBe("insurance"); // plain alef vs أ
    expect(lexicalSearch(KB, "تأمين")[0]?.id).toBe("insurance");
    expect(lexicalSearch(KB, "كم العربون")[0]?.id).toBe("deposit");
  });
  it("English questions find English content and (via the concept table) Arabic content", () => {
    expect(lexicalSearch(KB, "Is there parking?")[0]?.id).toBe("en-parking");
    expect(lexicalSearch(KB, "can I cancel my appointment")[0]?.id).toBe("en-cancel");
    expect(lexicalSearch(KB, "what are your opening hours?")[0]?.id).toBe("hours");
    expect(lexicalSearch(KB, "do you take insurance")[0]?.id).toBe("insurance");
  });
  it("orders by score, best first, and caps at k", () => {
    const docs = [
      ch("a", "parking parking parking lot"),
      ch("b", "we have a small parking area and a big garden with lots of other things going on here today"),
      ch("c", "garden"),
    ];
    const r = lexicalSearch(docs, "parking", { k: 2 });
    expect(r.map((x) => x.id)).toEqual(["a", "b"]);
    expect(r[0].score).toBeGreaterThan(r[1].score);
    expect(lexicalSearch(docs, "parking", { k: 1 })).toHaveLength(1);
  });
  it("returns nothing for unrelated, stopword-only or empty queries (the model then says it does not know)", () => {
    expect(lexicalSearch(KB, "what is the capital of France")).toEqual([]);
    expect(lexicalSearch(KB, "ما هي")).toEqual([]);
    expect(lexicalSearch(KB, "")).toEqual([]);
    expect(lexicalSearch([], "hours")).toEqual([]);
  });
  it("a multi-term query needs enough of its terms to match", () => {
    const docs = [ch("x", "laser hair removal sessions"), ch("y", "unrelated text about teeth")];
    expect(lexicalSearch(docs, "laser removal cost refund policy xyz").map((r) => r.id)).not.toContain("y");
  });
});

import { visitorOf } from "./helpers";

function ctx(db: AgentDb, embedQuery: ToolContext["embedQuery"]): ToolContext {
  return { db, tenantId: TENANT, conversationId: CONV, timezone: "Asia/Riyadh", locale: "ar", embedQuery, visitor: visitorOf() };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const search = (c: ToolContext, query: string): Promise<any> => (createTools(c).search_knowledge as any).execute({ query }, { toolCallId: "t", messages: [] });

describe("search_knowledge: hybrid (semantic + lexical, fused)", () => {
  const rows = KB.map((k) => ({ ...k }));
  const vec = async () => Array(768).fill(0.01);
  const sem = (id: string, content: string, similarity: number) => ({ id, content, similarity });

  it("a strong semantic hit with every chunk embedded needs no lexical pass", async () => {
    const f = fakeDb({ tables: { kb_chunks: rows, "kb_chunks:null": [] }, rpc: { match_kb_chunks: { data: [sem("hours", "semantic hit", 0.8)] } } });
    const r = await search(ctx(f.db, vec), "hours");
    expect(r).toMatchObject({ ok: true, untrusted_data: true });
    expect(r.results[0]).toMatchObject({ content: "semantic hit", source: "semantic", similarity: 0.8 });
  });

  it("ANY unembedded chunk triggers the lexical pass: one irrelevant semantic hit no longer hides the hours chunk", async () => {
    const f = fakeDb({
      tables: { kb_chunks: rows, "kb_chunks:null": [{ id: "x" }] },
      rpc: { match_kb_chunks: { data: [sem("en-parking", KB[3].content, 0.82)] } },
    });
    const r = await search(ctx(f.db, vec), "ما هي ساعات العمل؟");
    const contents = r.results.map((x: { content: string }) => x.content);
    expect(contents.some((c: string) => c.includes("ساعات العمل"))).toBe(true);
    expect(r.results.find((x: { content: string }) => x.content.includes("ساعات العمل")).source).toBe("lexical");
    expect(r.results.find((x: { content: string }) => x.content.includes("parking")).source).toBe("semantic");
  });

  it("a weak semantic top score (below 0.6) also triggers it", async () => {
    const f = fakeDb({ tables: { kb_chunks: rows, "kb_chunks:null": [] }, rpc: { match_kb_chunks: { data: [sem("en-parking", KB[3].content, 0.5)] } } });
    const r = await search(ctx(f.db, vec), "ما هي ساعات العمل؟");
    expect(r.results.some((x: { content: string }) => x.content.includes("ساعات العمل"))).toBe(true);
  });

  it("the same chunk found by both is merged once and marked both", async () => {
    const f = fakeDb({ tables: { kb_chunks: rows, "kb_chunks:null": [{ id: "x" }] }, rpc: { match_kb_chunks: { data: [sem("hours", KB[0].content, 0.9)] } } });
    const r = await search(ctx(f.db, vec), "ما هي ساعات العمل؟");
    expect(r.results.filter((x: { content: string }) => x.content.includes("ساعات العمل"))).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ source: "both", score: 1 });
  });

  it("similarities under the 0.45 noise floor are dropped (0.3 let unrelated chunks through)", async () => {
    const f = fakeDb({ tables: { kb_chunks: rows, "kb_chunks:null": [] }, rpc: { match_kb_chunks: { data: [sem("en-parking", KB[3].content, 0.35)] } } });
    const r = await search(ctx(f.db, vec), "quantum chromodynamics");
    expect(r.results).toEqual([]);
  });

  it.each([
    ["no embedded chunks (empty RPC result)", { rpc: { match_kb_chunks: { data: [] } }, embed: vec }],
    ["embedding call failed / quota", { rpc: { match_kb_chunks: { data: [sem("a", "never", 0.9)] } }, embed: async () => { throw Object.assign(new Error("quota"), { statusCode: 429 }); } }],
    ["match RPC error", { rpc: { match_kb_chunks: { error: { message: "boom" } } }, embed: vec }],
  ])("lexical still answers: %s", async (_n, c) => {
    const f = fakeDb({ tables: { kb_chunks: rows }, rpc: c.rpc as never });
    const r = await search(ctx(f.db, c.embed), "ما هي ساعات العمل؟");
    expect(r).toMatchObject({ ok: true, untrusted_data: true });
    expect(r.results[0]).toMatchObject({ source: "lexical" });
    expect(r.note).toMatch(/keyword/);
    expect(r.results[0].content).toContain("ساعات العمل");
  });

  it("nothing relevant returns an empty list", async () => {
    const f = fakeDb({ tables: { kb_chunks: rows }, rpc: { match_kb_chunks: { data: [] } } });
    const r = await search(ctx(f.db, vec), "quantum chromodynamics");
    expect(r).toMatchObject({ ok: true, results: [] });
  });
});

// ---- against the seeded demo data of the LOCAL Supabase stack (skipped when it is not running) ----
function localEnv(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    return readFileSync(".env.local", "utf8").match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
  } catch {
    return undefined;
  }
}
const URL_ = localEnv("NEXT_PUBLIC_SUPABASE_URL");
const KEY = localEnv("SUPABASE_SERVICE_ROLE_KEY");
let reachable = false;
if (URL_ && KEY && /127\.0\.0\.1|localhost/.test(URL_)) {
  try {
    reachable = (await fetch(`${URL_}/rest/v1/`, { headers: { apikey: KEY }, signal: AbortSignal.timeout(2000) })).status < 500;
  } catch {
    reachable = false;
  }
}

describe.skipIf(!reachable)("seeded demo data (local DB, chunks have no embeddings)", () => {
  const client = () => createClient(URL_!, KEY!, { auth: { persistSession: false } });
  const tenantIdOf = async () => {
    const { data: t } = await client().from("tenants").select("id").eq("slug", "demo-clinic").single();
    return (t as { id: string }).id;
  };

  it("the Arabic hours question finds the hours chunk, and the English question finds it too", async () => {
    const db = client() as unknown as AgentDb;
    const tenantId = await tenantIdOf();
    const c: ToolContext = { ...ctx(db, async () => Array(768).fill(0)), tenantId };
    const ar = await search(c, "ما هي ساعات العمل؟");
    expect(ar.results[0].source).toBe("lexical");
    expect(ar.results[0].content).toContain("ساعات العمل: من الأحد إلى الخميس");
    const en = await search(c, "What are your opening hours?");
    expect(en.results[0].content).toContain("ساعات العمل");
  });

  it("REGRESSION: with ONE unrelated chunk embedded (strong semantic hit), the hours chunk is still found", async () => {
    const sb = client();
    const tenantId = await tenantIdOf();
    const { data: chunks } = await sb.from("kb_chunks").select("id, content").eq("tenant_id", tenantId).order("chunk_index");
    const unrelated = (chunks as { id: string; content: string }[]).find((x) => !x.content.includes("ساعات العمل"))!;
    const vector = `[${Array(768).fill(0.05).join(",")}]`;
    const { error } = await sb.from("kb_chunks").update({ embedding: vector }).eq("id", unrelated.id);
    expect(error).toBeNull();
    try {
      const c: ToolContext = { ...ctx(sb as unknown as AgentDb, async () => Array(768).fill(0.05)), tenantId };
      const r = await search(c, "ما هي ساعات العمل؟");
      const contents = r.results.map((x: { content: string }) => x.content);
      expect(contents.some((x: string) => x.includes("ساعات العمل: من الأحد إلى الخميس"))).toBe(true);
      expect(r.results.map((x: { source: string }) => x.source)).toContain("semantic");
    } finally {
      await sb.from("kb_chunks").update({ embedding: null }).eq("id", unrelated.id);
    }
  });
});
