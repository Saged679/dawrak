import type { LanguageModel } from "ai";
import { e2eMockEnabled } from "./mock-gate";

/**
 * Offline scripted model for e2e (see mock-gate.ts: env opt-ins plus header, never on Vercel, ALLOW_E2E_MOCKS in production). It exists so Playwright
 * can drive the REAL chat route and tools without Gemini:
 *   user text `BOOK {json}`  -> one create_booking tool call with that input (user_confirmed forced true)
 *   after a tool result      -> text `RESULT <the tool result JSON, exactly what the model received>`
 *   anything else            -> "Hello from the mock assistant."
 */
export async function mockChatModel(req: Request): Promise<LanguageModel | null> {
  // Defence in depth: the route already checked this gate before importing the module.
  if (!e2eMockEnabled(req.headers)) return null;
  const { MockLanguageModelV4, convertArrayToReadableStream } = await import("ai/test");
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  type Part = { type: string; text?: string; output?: unknown };
  type Msg = { role: string; content: string | Part[] };
  return new MockLanguageModelV4({
    doStream: async ({ prompt }: { prompt: Msg[] }) => {
      const last = prompt[prompt.length - 1];
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      let tool = false;
      if (last?.role === "tool") {
        const res = (last.content as Part[]).map((c) => JSON.stringify(c.output ?? null)).join(" ");
        parts.push({ type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: `RESULT ${res}` }, { type: "text-end", id: "t1" });
      } else {
        const text = Array.isArray(last?.content)
          ? last.content.map((c) => c.text ?? "").join("")
          : (last?.content ?? "");
        const m = /^BOOK (\{[\s\S]*\})$/.exec(text.trim());
        if (m) {
          tool = true;
          const input = { ...JSON.parse(m[1]), user_confirmed: true };
          parts.push({ type: "tool-call", toolCallId: "mock-call-1", toolName: "create_booking", input: JSON.stringify(input) });
        } else {
          parts.push(
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Hello from the mock assistant." },
            { type: "text-end", id: "t1" },
          );
        }
      }
      parts.push({ type: "finish", finishReason: { unified: tool ? "tool-calls" : "stop", raw: undefined }, usage });
      return { stream: convertArrayToReadableStream(parts as never[]) };
    },
  }) as unknown as LanguageModel;
}
