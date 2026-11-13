import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { AgentDb } from "@/lib/agent/types";

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

  const db = {
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ fn, args });
      const h = spec.rpc?.[fn] ?? (fn === "check_rate_limit" ? { data: true } : undefined);
      const r = typeof h === "function" ? h(args) : (h ?? { data: null });
      return { data: r.data ?? null, error: r.error ?? null };
    },
    from(table: string) {
      let op = "select";
      const q: Record<string, unknown> = {};
      const done = () => ({ data: spec.tables?.[table] ?? null, error: null });
      const chain = () => q;
      for (const m of ["select", "eq", "in", "order", "limit"]) q[m] = chain;
      for (const m of ["insert", "update", "delete"]) {
        q[m] = (payload?: unknown) => {
          op = m;
          writes.push({ table, op: m, payload });
          return q;
        };
      }
      q.maybeSingle = async () => done();
      q.single = async () => {
        const r = done();
        return r.data ? r : { data: { id: "11111111-1111-4111-8111-111111111111" }, error: null };
      };
      q.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(op === "select" ? done() : { data: null, error: null }).then(res);
      return q;
    },
  } as unknown as AgentDb;

  return { db, rpcCalls, writes };
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
