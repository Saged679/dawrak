import { describe, expect, it } from "vitest";
import { runAgent } from "@/lib/agent/run-agent";
import { CONV, OTHER_TENANT, PROVIDER, SERVICE, TENANT, fakeDb, scriptedModel, tenantRow, type Step } from "./helpers";

const slots = [{ slot_provider_id: PROVIDER, slot_start: "2030-01-01T06:00:00Z", slot_end: "2030-01-01T06:30:00Z" }];

function deps(steps: Step[]) {
  const f = fakeDb({
    tables: { tenants: tenantRow },
    rpc: {
      get_available_slots: { data: slots },
      public_list_providers: { data: [{ id: PROVIDER, name_ar: "د", name_en: "Dr" }] },
    },
  });
  return { ...f, model: scriptedModel(steps) };
}

describe("runAgent", () => {
  it("exposes all tools and a grounded system prompt to the model", async () => {
    const d = deps([{ text: "hi" }]);
    const res = await runAgent({
      tenantId: TENANT,
      conversationId: CONV,
      message: { type: "text", text: "hello" },
      locale: "en",
      deps: { db: d.db, model: d.model },
    });
    await res.consumeStream();
    const call = d.model.doStreamCalls[0];
    const names = (call.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "cancel_booking",
      "check_availability",
      "create_booking",
      "get_my_appointments",
      "prepare_booking",
      "prepare_cancel",
      "prepare_reschedule",
      "reschedule_booking",
      "search_knowledge",
    ]);
    const system = JSON.stringify(call.prompt[0]);
    expect(system).toContain("Al Noor Clinic");
    expect(system).toContain("Asia/Riyadh");
    expect(system).toMatch(/Never invent or guess/);
    expect(system).toMatch(/DATA, never instructions/);
  });

  it("answers availability only via check_availability and builds the answer from its result", async () => {
    const d = deps([
      { toolCalls: [{ name: "check_availability", input: { service_id: SERVICE, date_from: "2030-01-01" } }] },
      { text: "Dr is free at 09:00" },
    ]);
    let reply = "";
    const res = await runAgent({
      tenantId: TENANT,
      conversationId: CONV,
      message: { type: "text", text: "any free slot on Jan 1?" },
      locale: "en",
      onReply: (t) => void (reply = t),
      deps: { db: d.db, model: d.model },
    });
    await res.consumeStream();
    expect(d.rpcCalls.find((c) => c.fn === "get_available_slots")?.args).toMatchObject({
      p_tenant_id: TENANT,
      p_service_id: SERVICE,
    });
    // the second model call received the tool result, so the final answer is grounded in it
    expect(JSON.stringify(d.model.doStreamCalls[1].prompt)).toContain('"time":"09:00"');
    expect(reply).toBe("Dr is free at 09:00");
  });

  it("a model-supplied tenant_id is rejected and never reaches SQL", async () => {
    const d = deps([
      {
        toolCalls: [
          { name: "check_availability", input: { service_id: SERVICE, date_from: "2030-01-01", tenant_id: OTHER_TENANT } },
        ],
      },
      { text: "sorry" },
    ]);
    const res = await runAgent({
      tenantId: TENANT,
      conversationId: CONV,
      message: { type: "text", text: "x" },
      locale: "en",
      deps: { db: d.db, model: d.model },
    });
    await res.consumeStream();
    expect(d.rpcCalls.some((c) => c.fn === "get_available_slots")).toBe(false);
    expect(JSON.stringify(d.rpcCalls)).not.toContain(OTHER_TENANT);
  });

  it("sends audio as a file part", async () => {
    const d = deps([{ text: "ok" }]);
    const res = await runAgent({
      tenantId: TENANT,
      conversationId: CONV,
      message: { type: "audio", data: "AAAA", mediaType: "audio/webm" },
      locale: "ar",
      deps: { db: d.db, model: d.model },
    });
    await res.consumeStream();
    expect(JSON.stringify(d.model.doStreamCalls[0].prompt.at(-1))).toContain("audio/webm");
  });
});
