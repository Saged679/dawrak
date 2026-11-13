import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMoyasarProvider } from "@/lib/payments/moyasar";

const process = vi.fn();
const settle = vi.fn();
const fetchImpl = vi.fn();
const provider = createMoyasarProvider({
  secretKey: "sk_test_x",
  webhookSecret: "right-secret",
  fetchImpl: fetchImpl as unknown as typeof fetch,
});

vi.mock("@/lib/payments", () => ({ getPaymentProvider: () => provider }));
vi.mock("@/lib/payments/process", () => ({ processPaymentEvent: (...a: unknown[]) => process(...a) }));
vi.mock("@/lib/payments/store", () => ({ supabasePaymentStore: () => ({ settle }) }));

import { POST } from "./route";

const req = (body: string) => new Request("http://x.test/api/webhooks/moyasar", { method: "POST", body });
const evt = (secret: string, type = "payment_paid") =>
  JSON.stringify({ id: "e1", type, secret_token: secret, data: { id: "pay_12345678", invoice_id: "inv-1" } });

describe("POST /api/webhooks/moyasar", () => {
  beforeEach(() => {
    process.mockReset();
    settle.mockReset();
    fetchImpl.mockReset();
  });

  it("answers 401 for a wrong secret and does no work (no API call, no database)", async () => {
    const res = await POST(req(evt("wrong")));
    expect(res.status).toBe(401);
    expect(process).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("answers 401 for garbage and for a missing token", async () => {
    expect((await POST(req("<html>"))).status).toBe(401);
    expect((await POST(req(JSON.stringify({ id: "e", type: "payment_paid" })))).status).toBe(401);
    expect(process).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before parsing", async () => {
    expect((await POST(req("x".repeat(70_000)))).status).toBe(413);
  });

  it("authenticated events are processed and acknowledged with 2xx", async () => {
    process.mockResolvedValue({ kind: "settled", outcome: "confirmed" });
    const res = await POST(req(evt("right-secret")));
    expect(res.status).toBe(200);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("answers 5xx when processing fails so the provider retries", async () => {
    process.mockRejectedValue(new Error("moyasar_http_503"));
    expect((await POST(req(evt("right-secret")))).status).toBe(500);
  });

  it("a verification event is acknowledged without processing", async () => {
    const res = await POST(
      req(JSON.stringify({ id: "v1", type: "webhook_verification", secret_token: "right-secret", data: { verification_code: "123456" } })),
    );
    expect(res.status).toBe(200);
    expect(process).not.toHaveBeenCalled();
  });
});
