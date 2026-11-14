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

function ctx(db: AgentDb, embedQuery: ToolContext["embedQuery"]): ToolContext {
  return { db, tenantId: TENANT, conversationId: CONV, timezone: "Asia/Riyadh", locale: "ar", embedQuery };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const search = (c: ToolContext, query: string): Promise<any> => (createTools(c).search_knowledge as any).execute({ query }, { toolCallId: "t", messages: [] });

describe("search_knowledge: semantic first, lexical fallback", () => {
  const rows = KB.map((k) => ({ ...k }));
  const vec = async () => Array(768).fill(0.01);

  it("uses the semantic result when it has usable matches", async () => {
    const f = fakeDb({ tables: { kb_chunks: rows }, rpc: { match_kb_chunks: { data: [{ content: "semantic hit", similarity: 0.8 }] } } });
    const r = await search(ctx(f.db, vec), "hours");
    expect(r).toMatchObject({ ok: true, source: "semantic" });
    expect(r.lexical).toBeUndefined();
    expect(r.results[0].content).toBe("semantic hit");
  });

  it.each([
    ["no embedded chunks (empty RPC result)", { rpc: { match_kb_chunks: { data: [] } }, embed: vec }],
    ["only weak semantic matches", { rpc: { match_kb_chunks: { data: [{ content: "meh", similarity: 0.1 }] } }, embed: vec }],
    ["embedding call failed / quota", { rpc: { match_kb_chunks: { data: [{ content: "never", similarity: 0.9 }] } }, embed: async () => { throw Object.assign(new Error("quota"), { statusCode: 429 }); } }],
    ["match RPC error", { rpc: { match_kb_chunks: { error: { message: "boom" } } }, embed: vec }],
  ])("falls back to lexical: %s", async (_n, c) => {
    const f = fakeDb({ tables: { kb_chunks: rows }, rpc: c.rpc as never });
    const r = await search(ctx(f.db, c.embed), "ما هي ساعات العمل؟");
    expect(r).toMatchObject({ ok: true, source: "lexical", lexical: true, untrusted_data: true });
    expect(r.note).toMatch(/keyword/);
    expect(r.results[0].content).toContain("ساعات العمل");
  });

  it("lexical with nothing relevant returns an empty list, still flagged lexical", async () => {
    const f = fakeDb({ tables: { kb_chunks: rows }, rpc: { match_kb_chunks: { data: [] } } });
    const r = await search(ctx(f.db, vec), "quantum chromodynamics");
    expect(r).toMatchObject({ ok: true, lexical: true, results: [] });
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
  it("'ساعات العمل' finds the hours chunk lexically, and the English question finds it too", async () => {
    const db = createClient(URL_!, KEY!, { auth: { persistSession: false } }) as unknown as AgentDb;
    const { data: t } = await db.from("tenants").select("id").eq("slug", "demo-clinic").single();
    const tenantId = (t as { id: string }).id;
    const { count } = await (db as unknown as ReturnType<typeof createClient>)
      .from("kb_chunks")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .not("embedding", "is", null);
    // the premise of the bug: reset_demo() seeds chunks without embeddings
    expect(count).toBe(0);
    const c: ToolContext = { db, tenantId, conversationId: CONV, timezone: "Asia/Riyadh", locale: "ar", embedQuery: async () => Array(768).fill(0) };
    const ar = await search(c, "ما هي ساعات العمل؟");
    expect(ar.source).toBe("lexical");
    expect(ar.results[0].content).toContain("ساعات العمل: من الأحد إلى الخميس");
    const en = await search(c, "What are your opening hours?");
    expect(en.results[0].content).toContain("ساعات العمل");
  });
});
