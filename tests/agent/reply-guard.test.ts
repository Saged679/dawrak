import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@/lib/agent/prompt";
import { runAgent } from "@/lib/agent/run-agent";
import { TurnState, claimsActionDone, guardReply, looksLikeTechnicalApology } from "@/lib/agent/turn-guard";
import { CONV, TENANT, confirmedMessages, fakeDb, fullTenantRow, pendingCreate, scriptedModel, type Step } from "./helpers";

const tenant = { id: TENANT, name_ar: "عيادة النور", name_en: "Al Noor Clinic", kind: "clinic" as const, timezone: "Asia/Riyadh", currency: "SAR" };

describe("system prompt: honesty and style rules", () => {
  const p = buildSystemPrompt(tenant, "ar");
  it("forbids claiming an action before the tool succeeded and requires calling the tool right after confirmation", () => {
    expect(p).toMatch(/NEVER say that something is booked, confirmed, cancelled or moved unless create_booking, cancel_booking or reschedule_booking returned ok/);
    expect(p).toMatch(/Wait for their NEXT message/);
    expect(p).toMatch(/A prepare_ result is only a summary/);
    expect(p).toMatch(/error[\s\S]{0,200}honestly/);
  });
  it("asks for plain text without Markdown and for gender-neutral Arabic", () => {
    expect(p).toMatch(/Plain text only/);
    expect(p).toMatch(/NEVER use Markdown/);
    expect(p).toMatch(/NEVER assume the visitor's gender/i);
    expect(p).toContain("تودين");
    expect(p).toMatch(/dialect/);
  });
  it("tells the model how to react to rejected tool arguments", () => {
    expect(p).toMatch(/arguments were invalid/);
    expect(p).toMatch(/not a technical problem/);
  });
});

describe("claimsActionDone (Arabic and English, narrow on purpose)", () => {
  it.each([
    "تم حجز موعدك يوم الأحد الساعة 9",
    "تم تأكيد حجزك بنجاح",
    "تم إلغاء الموعد",
    "تم تعديل موعدك",
    "حجزت لك موعد مع الدكتور",
    "موعدك مؤكد",
    "Your appointment is confirmed for Sunday.",
    "I've booked you with Dr Sara.",
    "Your booking has been cancelled.",
    "Great, you're booked: the appointment is now confirmed.",
  ])("claim: %s", (t) => expect(claimsActionDone(t)).toBe(true));

  it.each([
    "هل تريد أن أحجز لك الموعد؟",
    "سأحجز لك الموعد بعد التأكيد",
    "هل تؤكد الحجز؟",
    "أي وقت يناسب للحجز؟",
    "الحجز يحتاج اسمك ورقم جوالك",
    "Would you like me to book this slot?",
    "I can book that for you once you confirm.",
    "Shall I confirm the appointment?",
    "To book, I need your name and phone number.",
    "",
  ])("not a claim: %s", (t) => expect(claimsActionDone(t)).toBe(false));
});

describe("looksLikeTechnicalApology", () => {
  it.each(["عذراً، حدثت مشكلة تقنية", "واجهنا خطأ تقني", "Sorry, there was a technical problem.", "Something went wrong"])("%s", (t) =>
    expect(looksLikeTechnicalApology(t)).toBe(true),
  );
  it.each(["الموعد غير متاح", "That slot is taken"])("%s", (t) => expect(looksLikeTechnicalApology(t)).toBe(false));
});

describe("guardReply", () => {
  it("replaces a booking claim when a booking tool failed and none succeeded", () => {
    const t = new TurnState();
    t.record("create_booking", "fail");
    const r = guardReply("تم حجز موعدك", t);
    expect(r.changed).toBe("claim_replaced");
    expect(r.text).not.toMatch(/تم حجز/);
    expect(r.text).toMatch(/لم يتم/);
    const en = guardReply("Your appointment is confirmed!", t);
    expect(en.text).toMatch(/has not gone through/);
  });
  it("keeps the claim when the booking tool succeeded", () => {
    const t = new TurnState();
    t.record("create_booking", "ok");
    expect(guardReply("تم حجز موعدك", t).changed).toBe("none");
  });
  it("a failure that was fixed by a later success is not unresolved", () => {
    const t = new TurnState();
    t.record("create_booking", "invalid");
    t.record("create_booking", "ok");
    expect(guardReply("تم حجز موعدك", t).changed).toBe("none");
  });
  it("without any booking attempt in the turn the text is left alone (it may describe an earlier booking)", () => {
    expect(guardReply("نعم، تم حجز موعدك سابقاً", new TurnState()).changed).toBe("none");
  });
  it("does not touch a technical apology when the failure was a real error result (not validation)", () => {
    const t = new TurnState();
    t.record("create_booking", "fail");
    expect(guardReply("Sorry, a technical problem happened.", t).changed).toBe("none");
  });
});

describe("premature claim through the real agent loop (mock model)", () => {
  const P = pendingCreate();
  const good = { confirmation_token: P.token };
  const state = { chat_agent_state: { state: P.state } };
  async function turn(steps: Step[], db = fakeDb({ tables: { tenants: fullTenantRow, messages: confirmedMessages, ...state }, rpc: { create_public_booking: { error: { code: "23P01", message: "slot_taken" } } } })) {
    let saved = "";
    const res = await runAgent({
      tenantId: TENANT,
      conversationId: CONV,
      message: { type: "text", text: "ايوه أكد" },
      locale: "ar",
      onReply: (t) => void (saved = t),
      deps: { db: db.db, model: scriptedModel(steps) },
    });
    await res.consumeStream();
    return saved;
  }

  it("claims 'booked' although create_booking failed: the stored reply is the honest correction", async () => {
    const saved = await turn([
      { toolCalls: [{ name: "create_booking", input: good }] },
      { text: "تم حجز موعدك بنجاح" },
    ]);
    expect(saved).not.toMatch(/تم حجز/);
    expect(saved).toMatch(/لم يتم/);
  });

  it("claims 'booked' after the booking tool really succeeded: stored as is", async () => {
    const db = fakeDb({
      tables: { tenants: fullTenantRow, messages: confirmedMessages, ...state },
      rpc: { create_public_booking: { data: { appointment_id: "99999999-9999-4999-8999-999999999999", status: "confirmed", starts_at: "2030-01-01T06:30:00Z", customer_token: null } } },
    });
    const saved = await turn(
      [{ toolCalls: [{ name: "create_booking", input: good }] }, { text: "تم حجز موعدك بنجاح" }],
      db,
    );
    expect(saved).toBe("تم حجز موعدك بنجاح");
  });
});
