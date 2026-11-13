import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
const providerFor = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({ getServiceClient: () => ({ rpc }) }));
vi.mock("@/lib/mail", () => ({ mailProviderFor: (...a: unknown[]) => providerFor(...a) }));
vi.mock("@/lib/customer/portal", () => ({ loadPortal: vi.fn() }));

import { sendLinkEmail } from "@/lib/customer/emails";
import { MailError } from "@/lib/mail/types";

const demoTenant = { id: "t-demo", slug: "demo-clinic", is_demo: true, name_ar: "ع", name_en: "Demo" };
const realTenant = { id: "t-real", slug: "real", is_demo: false, name_ar: "ع", name_en: "Real" };
const row = { link_token: "a".repeat(48), contact_email: "p@example.com", contact_name: "Pat", contact_locale: "en" };

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: [row], error: null });
  send.mockReset().mockResolvedValue({ id: null });
  providerFor.mockReset().mockReturnValue({ name: "outbox", send });
});

describe("sendLinkEmail (H2 / M1)", () => {
  it("M1: when the mail provider is not configured the customer's link is never touched", async () => {
    providerFor.mockImplementation(() => {
      throw new MailError("mail_not_configured", true);
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await sendLinkEmail({ tenant: realTenant, phone: "+966501234567", email: null, sessionHash: null });
    expect(rpc).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("H2: a demo tenant passes the visitor's session hash to customer_issue_link", async () => {
    await sendLinkEmail({ tenant: demoTenant, phone: "+966501234567", email: null, sessionHash: "h".repeat(64) });
    expect(rpc).toHaveBeenCalledWith("customer_issue_link", {
      p_tenant_id: "t-demo",
      p_phone: "+966501234567",
      p_email: null,
      p_session_hash: "h".repeat(64),
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("H2: a real tenant always passes null, even if a stray hash is supplied; no p_force (reuse, no rotation)", async () => {
    await sendLinkEmail({ tenant: realTenant, phone: null, email: "p@example.com", sessionHash: "h".repeat(64) });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_session_hash).toBeNull();
    expect("p_force" in args).toBe(false);
  });

  it("H2: visitor B without a binding gets an empty result and nothing is sent", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await sendLinkEmail({ tenant: demoTenant, phone: "+966501234567", email: null, sessionHash: "b".repeat(64) });
    expect(send).not.toHaveBeenCalled();
  });

  it("a demo visitor without any session cookie hash passes null (the DB then refuses to issue)", async () => {
    await sendLinkEmail({ tenant: demoTenant, phone: "+966501234567", email: null, sessionHash: null });
    expect((rpc.mock.calls[0][1] as Record<string, unknown>).p_session_hash).toBeNull();
  });
});
