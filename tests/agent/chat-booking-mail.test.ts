import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const TOKEN = "t".repeat(48);
const outbox: { fn: string; args: Record<string, unknown> }[] = [];

vi.mock("@/lib/db/client", () => ({
  getServiceClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      outbox.push({ fn, args });
      return { data: null, error: null };
    },
  }),
}));
vi.mock("@/lib/customer/portal", () => ({
  loadPortal: async () => ({
    tenant: { name_ar: "عيادة", name_en: "Clinic", timezone: "Asia/Riyadh" },
    fullName: "Sara Test",
    appointments: [
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        serviceNameAr: "كشف",
        serviceNameEn: "Checkup",
        providerNameAr: "د. نور",
        providerNameEn: "Dr Noor",
        startsAt: "2030-01-01T09:00:00Z",
        status: "confirmed",
      },
    ],
  }),
}));

import { handleChat } from "@/lib/agent/chat-handler";
import { DEMO_SESSION_COOKIE } from "@/lib/demo/session";
import { hashArgs, signConfirmation } from "@/lib/agent/confirm";
import { bookingHash } from "@/lib/agent/tools";
import { APPT, DELIVERED_ID, timed, PROVIDER, SERVICE, TENANT, fakeDb, fullTenantRow, scriptedModel } from "./helpers";

const EMAIL = "sara.private@mail-co.dev";
const CONVID = "11111111-1111-4111-8111-111111111111";
const STARTS = "2030-01-01T06:00:00.000Z"; // 09:00 in Asia/Riyadh
const booking = {
  service_id: SERVICE,
  provider_id: PROVIDER,
  date: "2030-01-01",
  time: "09:00",
  full_name: "Sara Test",
  phone: "+966512345678",
  email: EMAIL,
};
const pendingState = (email: string | undefined) => {
  const args: Record<string, string> = { ...booking, ...(email ? { email } : {}) } as never;
  const argsHash = hashArgs(bookingHash(booking, STARTS, email));
  const { token, jti, expiresAt } = signConfirmation({ tenantId: TENANT, conversationId: CONVID, action: "create_booking", argsHash, userMessageCount: 1 });
  return { token, state: { pending: { action: "create_booking", token, jti, argsHash, summary: "s", args, expiresAt, delivered_message_id: DELIVERED_ID } } };
};

function run(opts: { demo: boolean; token?: string | null; cookie?: string; email?: string }) {
  const P = pendingState((opts.email ?? EMAIL).toLowerCase());
  const f = fakeDb({
    tables: {
      tenants: fullTenantRow,
      conversations: { id: CONVID },
      customers: { id: "cust-1" },
      chat_agent_state: { state: P.state },
      messages: timed([
        { role: "user", content: `I am Sara Test, phone +966512345678, email ${opts.email ?? EMAIL}`, parts: null },
        { id: DELIVERED_ID, role: "assistant", content: "summary", parts: null },
        { role: "user", content: "yes book it", parts: null },
      ]),
    },
    rpc: {
      public_get_tenant: { data: [{ id: TENANT, slug: "al-noor", is_demo: opts.demo }] },
      check_rate_limit: { data: true },
      create_public_booking: {
        data: { appointment_id: APPT, status: "confirmed", starts_at: STARTS, customer_token: opts.token === undefined ? TOKEN : opts.token },
      },
    },
  });
  const model = scriptedModel([{ toolCalls: [{ name: "create_booking", input: { confirmation_token: P.token } }] }, { text: "Booked." }]);
  const req = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    body: JSON.stringify({ tenantSlug: "al-noor", locale: "en", message: { type: "text", text: "yes book it" } }),
  });
  return { ...f, model, go: async () => { const res = await handleChat(req, { db: f.db, model }); const body = await res.text(); return { res, body }; } };
}

/** Everything the model was shown in tool-result messages (what a leak would have to travel through). */
const toolResultsSeen = (m: ReturnType<typeof scriptedModel>) =>
  JSON.stringify(m.doStreamCalls.flatMap((c) => (c.prompt as { role: string }[]).filter((p) => p.role === "tool")));

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  outbox.length = 0;
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  // a REAL provider is fully configured: the demo tenant must still never reach it
  vi.stubEnv("MAIL_PROVIDER", "resend");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("chat booking confirmation mail", () => {
  it("demo tenant: sets an httpOnly random session cookie, binds the booking and writes the mailbox row, never Resend", async () => {
    const s = run({ demo: true });
    const { res, body } = await s.go();
    const cookie = res.headers.get("set-cookie") ?? "";
    const raw = new RegExp(`${DEMO_SESSION_COOKIE}=([A-Za-z0-9_-]{43});`).exec(cookie)?.[1];
    expect(raw, cookie).toBeTruthy();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const hash = sha(raw!);
    const attach = s.rpcCalls.find((c) => c.fn === "demo_attach_session");
    expect(attach?.args).toMatchObject({ p_tenant_id: TENANT, p_appointment_id: APPT, p_session_hash: hash });
    const add = outbox.find((c) => c.fn === "demo_outbox_add");
    expect(add?.args).toMatchObject({ p_tenant_id: TENANT, p_session_hash: hash, p_kind: "booking", p_to: EMAIL });
    expect(JSON.stringify([outbox, s.rpcCalls])).not.toContain(raw!); // only the hash is stored
    expect(fetchMock).not.toHaveBeenCalled(); // no real provider call
    expect(body).toContain("Booked.");
  });

  it("demo tenant: an existing session cookie is reused (no new cookie) and keys the mailbox row", async () => {
    const raw = "A".repeat(43);
    const s = run({ demo: true, cookie: `${DEMO_SESSION_COOKIE}=${raw}` });
    const { res } = await s.go();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(outbox.find((c) => c.fn === "demo_outbox_add")?.args.p_session_hash).toBe(sha(raw));
  });


  it("real tenant: goes through the configured provider, no cookie, no outbox", async () => {
    const s = run({ demo: false });
    const { res } = await s.go();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(outbox).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("resend.com");
  });

  it("pre-existing customer (no token): no mail, honest result", async () => {
    const s = run({ demo: false, token: null });
    await s.go();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toolResultsSeen(s.model)).toContain("not_sent");
  });

  it("the model never sees the manage token, the email address or the session", async () => {
    for (const demo of [true, false]) {
      const s = run({ demo });
      await s.go();
      const seen = toolResultsSeen(s.model);
      expect(seen).toContain("confirmation_email");
      expect(seen).toContain(demo ? "demo_mailbox" : "queued");
      expect(seen).not.toContain(TOKEN);
      expect(seen).not.toContain(EMAIL);
      expect(seen).not.toContain("demo.invalid");
      expect(seen).not.toMatch(/dawrak_demo_session|[0-9a-f]{64}/);
    }
  });

  it("a failing mail provider does not fail the booking and is reported as not sent", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const s = run({ demo: false });
    const { body } = await s.go();
    expect(body).toContain("Booked.");
    expect(toolResultsSeen(s.model)).toContain("not_sent");
  });
});
