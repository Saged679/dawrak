import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { AgentDb } from "@/lib/agent/types";
import { createTools, bookingHash } from "@/lib/agent/tools";
import { hashArgs, signConfirmation } from "@/lib/agent/confirm";
import { localToInstant } from "@/lib/agent/local-time";
import type { ToolContext, VisitorContext } from "@/lib/agent/types";
import type { AgentState } from "@/lib/agent/state";

type Result = { data?: unknown; error?: { code?: string; message?: string } | null };
type RpcHandler = Result | ((args: Record<string, unknown>) => Result);

export type FakeDbSpec = {
  rpc?: Record<string, RpcHandler>;
  /** table -> value returned by select/maybeSingle/single */
  tables?: Record<string, unknown>;
};

export function fakeDb(spec: FakeDbSpec = {}) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const writes: { table: string; op: string; payload?: unknown }[] = [];
  /** chat_confirmation_uses behaves like the real table: (conversation_id, jti) is unique. */
  const used = new Set<string>();
  /** chat_agent_state behaves like the real table: one row per conversation with a version and compare-and-set updates. */
  let stateRow: { state: unknown; version: number } | null = (() => {
    const seed = spec.tables?.chat_agent_state as { state?: unknown; version?: number } | null | undefined;
    return seed ? { state: seed.state, version: seed.version ?? 0 } : null;
  })();
  const stateWrites: unknown[] = [];

  const db = {
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ fn, args });
      const h = spec.rpc?.[fn] ?? (fn === "check_rate_limit" ? { data: true } : undefined);
      const r = typeof h === "function" ? h(args) : (h ?? { data: null });
      return { data: r.data ?? null, error: r.error ?? null };
    },
    from(table: string) {
      let op = "select";
      let isNull = false;
      let payload: unknown;
      const filters: Record<string, unknown> = {};
      let orderBy: { col: string; asc: boolean } | null = null;
      const q: Record<string, unknown> = {};
      const done = () => {
        if (table === "chat_agent_state") return { data: stateRow ? { state: stateRow.state, version: stateRow.version } : null, error: null, count: undefined };
        let data = spec.tables?.[isNull ? `${table}:null` : table] ?? null;
        if (table === "messages" && Array.isArray(data)) {
          // rows may carry id / role / created_at: honour the filters and the ordering the code asks for
          let rows = data as { id?: string; role?: string; created_at?: string }[];
          if (filters.role !== undefined) rows = rows.filter((r) => r.role === filters.role);
          if (filters.id !== undefined) return { data: rows.find((r) => r.id === filters.id) ?? null, error: null, count: undefined };
          if (orderBy && rows.every((r) => (r as Record<string, unknown>)[orderBy!.col] !== undefined)) {
            const c = orderBy.col;
            rows = [...rows].sort((a, b) => String((a as Record<string, unknown>)[c]).localeCompare(String((b as Record<string, unknown>)[c])) * (orderBy!.asc ? 1 : -1));
          }
          data = rows;
        }
        return { data, error: null, count: Array.isArray(data) ? data.length : undefined };
      };
      const chain = () => q;
      for (const m of ["in", "limit", "neq", "gte", "lte"]) q[m] = chain;
      q.order = (col: string, o?: { ascending?: boolean }) => {
        orderBy = { col, asc: o?.ascending !== false };
        return q;
      };
      q.select = chain;
      q.eq = (col: string, val: unknown) => {
        filters[col] = val;
        return q;
      };
      q.is = (col: string, val: unknown) => {
        if (val === null) isNull = true;
        return q;
      };
      for (const m of ["insert", "update", "delete", "upsert"]) {
        q[m] = (p?: unknown) => {
          op = m;
          payload = p;
          writes.push({ table, op: m, payload: p });
          return q;
        };
      }
      q.maybeSingle = async () => done();
      q.single = async () => {
        if (op === "insert" && table === "messages") return { data: { id: "11111111-1111-4111-8111-111111111111" }, error: null };
        const r = done();
        return r.data ? r : { data: { id: "11111111-1111-4111-8111-111111111111" }, error: null };
      };
      const write = () => {
        if (table === "chat_agent_state") {
          if (op === "insert") {
            if (stateRow) return { data: null, error: { code: "23505", message: "duplicate key" } };
            const p = payload as { state: unknown; version: number };
            stateRow = { state: p.state, version: p.version };
            stateWrites.push(p.state);
            return { data: null, error: null };
          }
          if (op === "update") {
            if (!stateRow || filters.version !== stateRow.version) return { data: [], error: null };
            const p = payload as { state: unknown; version: number };
            stateRow = { state: p.state, version: p.version };
            stateWrites.push(p.state);
            return { data: [{ version: p.version }], error: null };
          }
        }
        if (table === "chat_confirmation_uses") {
          if (op === "insert") {
            const p = payload as { conversation_id: string; jti: string };
            const k = `${p.conversation_id}|${p.jti}`;
            if (used.has(k)) return { data: null, error: { code: "23505", message: "duplicate key" } };
            used.add(k);
          } else if (op === "delete") used.delete(`${filters.conversation_id}|${filters.jti}`);
        }
        return { data: null, error: null };
      };
      q.then = (res: (v: unknown) => unknown) => Promise.resolve(op === "select" ? done() : write()).then(res);
      return q;
    },
  } as unknown as AgentDb;

  return { db, rpcCalls, writes, used, stateWrites, getState: () => stateRow };
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

export type Step = { toolCalls?: { name: string; input: unknown }[]; text?: string };

/** Scripted model: each call to the model consumes the next step (the last one repeats). */
export function scriptedModel(steps: Step[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const s = steps[Math.min(i++, steps.length - 1)];
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      (s.toolCalls ?? []).forEach((c, n) =>
        parts.push({ type: "tool-call", toolCallId: `call-${i}-${n}`, toolName: c.name, input: JSON.stringify(c.input) }),
      );
      if (s.text) {
        parts.push(
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: s.text },
          { type: "text-end", id: "t1" },
        );
      }
      parts.push({
        type: "finish",
        finishReason: { unified: s.toolCalls?.length ? "tool-calls" : "stop", raw: undefined },
        usage,
      });
      return { stream: convertArrayToReadableStream(parts as never[]) };
    },
  });
}

export const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const SERVICE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const PROVIDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const APPT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const CONV = "ffffffff-ffff-4fff-8fff-ffffffffffff";

export const tenantRow = {
  id: TENANT,
  name_ar: "عيادة النور",
  name_en: "Al Noor Clinic",
  kind: "clinic",
  timezone: "Asia/Riyadh",
  currency: "SAR",
};

// ---------------------------------------------------------------------------------------------
// Two-phase confirmation helpers
// ---------------------------------------------------------------------------------------------

export const NAME = "Sara Ali";
export const PHONE = "+966500000000";
/** 17:30 on 2030-01-01 in Asia/Riyadh (UTC+3) is 14:30Z. */
export const SLOT_ISO = "2030-01-01T14:30:00.000Z";
export const fullTenantRow = { ...tenantRow, is_demo: false, deposit_enabled: false, deposit_type: "fixed", deposit_value: 0 };
export const serviceRow = { id: SERVICE, name_ar: "كشف", name_en: "Check-up", duration_min: 30, price: 150 };
export const providerRow = { id: PROVIDER, name_ar: "د. أحمد", name_en: "Dr Ahmed" };
export const slotRows = [
  { slot_provider_id: PROVIDER, slot_start: "2030-01-01T06:00:00Z", slot_end: "2030-01-01T06:30:00Z" },
  { slot_provider_id: PROVIDER, slot_start: SLOT_ISO, slot_end: "2030-01-01T15:00:00Z" },
  { slot_provider_id: PROVIDER, slot_start: "2030-01-01T15:00:00Z", slot_end: "2030-01-01T15:30:00Z" },
];

/** A visitor who wrote their details and is now answering. Counts and latest message are overridable. */
export function visitorOf(over: Partial<VisitorContext> = {}): VisitorContext {
  return {
    userMessageCount: 3,
    texts: ["I want a check-up tomorrow at 17:30", `${NAME} ${PHONE}`, "تأكيد"],
    latest: { type: "text", text: "تأكيد" },
    ...over,
  };
}

export const bookingArgs = { service_id: SERVICE, provider_id: PROVIDER, date: "2030-01-01", time: "17:30", full_name: NAME, phone: PHONE };

export type WorldOpts = { spec?: FakeDbSpec; ctx?: Partial<ToolContext>; locale?: "ar" | "en"; timezone?: string };

/** One fake database and a way to build the tools for different "turns" of the same conversation. */
export function world(opts: WorldOpts = {}) {
  const spec: FakeDbSpec = {
    ...opts.spec,
    tables: { tenants: fullTenantRow, ...opts.spec?.tables },
    rpc: {
      get_available_slots: { data: slotRows },
      public_list_services: { data: [serviceRow] },
      public_list_providers: { data: [providerRow] },
      create_public_booking: {
        data: { appointment_id: APPT, status: "confirmed", starts_at: SLOT_ISO, ends_at: "2030-01-01T15:00:00Z", price: 150, currency: "SAR", customer_token: null },
      },
      ...opts.spec?.rpc,
    },
  };
  const f = fakeDb(spec);
  /** The remembered state (pending confirmation...) shared by every "turn" of this conversation, like chat_agent_state. */
  const state = {
    current: {} as AgentState,
    async patch(p: AgentState) {
      this.current = { ...this.current, ...p };
    },
  };
  const turn = (visitor: Partial<VisitorContext>, extra: Partial<ToolContext> = {}) => {
    const ctx: ToolContext = {
      db: f.db,
      tenantId: TENANT,
      conversationId: CONV,
      timezone: opts.timezone ?? "Asia/Riyadh",
      locale: opts.locale ?? "en",
      embedQuery: async () => Array(768).fill(0.01),
      visitor: visitorOf(visitor),
      state,
      ...opts.ctx,
      ...extra,
    };
    const tools = createTools(ctx);
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const run = (name: keyof typeof tools, input: unknown): Promise<any> =>
      (tools[name] as any).execute(input, { toolCallId: "t", messages: [] });
    const validate = (name: keyof typeof tools, input: unknown): any => (tools[name] as any).inputSchema["~standard"].validate(input);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return { ctx, tools, run, validate };
  };
  /** Turn 1: the visitor gave their details (2 messages so far); the model prepares. */
  const prepared = async (args: Record<string, unknown> = bookingArgs, visitor: Partial<VisitorContext> = {}) => {
    const t = turn({ userMessageCount: 2, latest: { type: "text", text: `${NAME} ${PHONE}` }, ...visitor });
    const r = await t.run("prepare_booking", args);
    return { r, token: deliver() };
  };
  /** What runAgent does once the assistant message carrying the summary is persisted: marks the pending record delivered; returns its token. */
  const deliver = (): string => {
    const p = state.current.pending;
    if (!p) return "";
    void state.patch({ pending: { ...p, delivered_message_id: DELIVERED_ID } });
    return p.token;
  };
  return { ...f, turn, prepared, state, deliver };
}

/** Rows of the `messages` table for a visitor who gave details and then said yes (3 visitor messages). */
/** The assistant message that carried the pending summary (persisted = delivered), stored between the 2nd and 3rd visitor message. */
export const DELIVERED_ID = "abababab-abab-4bab-8bab-abababababab";
/** Gives rows increasing created_at values (one second apart), like the database would. */
export const timed = <T extends object>(rows: T[]) => rows.map((r, i) => ({ ...r, created_at: new Date(Date.UTC(2026, 10, 14, 10, 0, i)).toISOString() }));
export const confirmedMessages = timed([
  { role: "user", content: "I want a check-up on 2030-01-01 at 17:30", parts: null },
  { role: "user", content: `${NAME} ${PHONE}`, parts: null },
  { id: DELIVERED_ID, role: "assistant", content: "Booking summary ...", parts: null },
  { role: "user", content: "تأكيد", parts: null },
]);

/**
 * The chat_agent_state a prepare_booking would have left behind (for runAgent-level tests, which load state from the
 * table): a pending create_booking issued when the visitor had sent `issuedAfter` messages.
 */
export function pendingCreate(over: { email?: string; time?: string; issuedAfter?: number; expiresAt?: number } = {}) {
  const args: Record<string, string> = { service_id: SERVICE, provider_id: PROVIDER, date: "2030-01-01", time: over.time ?? "17:30", full_name: NAME, phone: PHONE, ...(over.email ? { email: over.email } : {}) };
  const instant = localToInstant(args.date, args.time, "Asia/Riyadh")!;
  const argsHash = hashArgs(bookingHash(args as never, instant, over.email));
  const { token, jti, expiresAt } = signConfirmation({ tenantId: TENANT, conversationId: CONV, action: "create_booking", argsHash, userMessageCount: over.issuedAfter ?? 2 });
  return { token, jti, state: { pending: { action: "create_booking" as const, token, jti, argsHash, summary: "summary", args, expiresAt: over.expiresAt ?? expiresAt, delivered_message_id: DELIVERED_ID } } };
}
