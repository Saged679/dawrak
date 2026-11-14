import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { instantToLocal } from "@/lib/agent/local-time";
import { AgentStateStore } from "@/lib/agent/state";
import { createTools } from "@/lib/agent/tools";
import type { AgentDb } from "@/lib/agent/types";

/**
 * Single use of a confirmation token against the REAL local Postgres (skipped when the stack is not running).
 * The action SUCCEEDS for exactly one caller: if the single-use insert (or its unique key) is removed, several
 * callers reach create_public_booking and this test fails on the call count and on the success count.
 */
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

describe.skipIf(!reachable)("confirmation single use in the real database", () => {
  it("N concurrent create_booking calls with the same token: exactly ONE books, the others get confirmation_already_used", async () => {
    const sb = createClient(URL_!, KEY!, { auth: { persistSession: false } });
    const { data: t } = await sb.from("tenants").select("id, timezone").eq("slug", "demo-salon").single();
    const tenant = t as { id: string; timezone: string };
    const { data: svcs } = await sb.rpc("public_list_services", { p_tenant_id: tenant.id });
    const svc = (svcs as { id: string }[])[0];
    const from = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    const { data: slots } = await sb.rpc("get_available_slots", { p_tenant_id: tenant.id, p_provider_id: null, p_service_id: svc.id, p_date_from: from, p_date_to: to, p_step_min: 30 });
    const slot = (slots as { slot_provider_id: string; slot_start: string }[])[3];
    const local = instantToLocal(slot.slot_start, tenant.timezone);
    const { data: c } = await sb.from("conversations").insert({ tenant_id: tenant.id, channel: "web" }).select("id").single();
    const conversationId = (c as { id: string }).id;
    const phone = `+9665${String(10000000 + Math.floor(Math.random() * 89999999))}`;
    const name = "Race Tester";
    let createCalls = 0;
    const db = {
      rpc: (fn: string, args: Record<string, unknown>) => {
        if (fn === "create_public_booking") createCalls++;
        return sb.rpc(fn, args);
      },
      from: (table: string) => sb.from(table),
    } as unknown as AgentDb;
    const state = new AgentStateStore(db, tenant.id, conversationId);
    type Exec = { execute: (i: unknown, o: unknown) => Promise<{ ok?: boolean; error?: string; confirmation_token?: string }> };
    const tools = (count: number, latest: string) =>
      createTools({
        db,
        tenantId: tenant.id,
        conversationId,
        timezone: tenant.timezone,
        locale: "en",
        embedQuery: async () => [],
        state,
        visitor: { userMessageCount: count, texts: [`book ${local.date} ${local.time}`, `${name} ${phone}`], latest: { type: "text", text: latest } },
      }) as unknown as Record<string, Exec>;
    const opts = { toolCallId: "t", messages: [] };
    try {
      const prep = await tools(2, `${name} ${phone}`).prepare_booking.execute(
        { service_id: svc.id, provider_id: slot.slot_provider_id, date: local.date, time: local.time, full_name: name, phone },
        opts,
      );
      expect(prep.ok).toBe(true);
      // what runAgent does once the assistant message with the summary is persisted
      const token = state.current.pending!.token;
      await state.patch({ pending: { ...state.current.pending!, delivered_message_id: "abababab-abab-4bab-8bab-abababababab" } });
      const N = 8;
      const results = await Promise.all(Array.from({ length: N }, () => tools(3, "تأكيد").create_booking.execute({ confirmation_token: token }, opts)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => r.error === "confirmation_already_used")).toHaveLength(N - 1);
      expect(createCalls).toBe(1); // the losers never reached the booking function
      const { count: uses } = await sb.from("chat_confirmation_uses").select("jti", { count: "exact", head: true }).eq("conversation_id", conversationId);
      expect(uses).toBe(1);
      const { count: appts } = await sb.from("appointments").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("starts_at", slot.slot_start).eq("provider_id", slot.slot_provider_id).neq("status", "cancelled");
      expect(appts).toBe(1);
      // replaying later (any turn) is refused too
      expect((await tools(3, "تأكيد").create_booking.execute({ confirmation_token: token }, opts)).error).toBe("confirmation_already_used");
      expect((await tools(4, "تأكيد").create_booking.execute({ confirmation_token: token }, opts)).error).toBe("confirmation_stale");
      // and the raw table enforces uniqueness
      const row = { tenant_id: tenant.id, conversation_id: conversationId, jti: "race-jti-0001", action: "create_booking" };
      const ins = await Promise.all(Array.from({ length: 6 }, () => sb.from("chat_confirmation_uses").insert(row)));
      expect(ins.filter((r) => !r.error)).toHaveLength(1);
      expect(ins.filter((r) => r.error?.code === "23505")).toHaveLength(5);
    } finally {
      const { data: cust } = await sb.from("customers").select("id").eq("tenant_id", tenant.id).eq("phone", phone);
      for (const cu of (cust ?? []) as { id: string }[]) {
        await sb.from("appointments").delete().eq("customer_id", cu.id);
        await sb.from("customers").delete().eq("id", cu.id);
      }
      await sb.from("conversations").delete().eq("id", conversationId);
    }
  });
});
