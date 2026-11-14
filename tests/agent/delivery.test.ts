import { describe, expect, it } from "vitest";
import { runAgent } from "@/lib/agent/run-agent";
import { guardPrepareText, redactTokens } from "@/lib/agent/turn-guard";
import { CONV, NAME, PHONE, TENANT, bookingArgs, fakeDb, fullTenantRow, providerRow, scriptedModel, serviceRow, slotRows, timed, type Step } from "./helpers";

/**
 * run-agent level (fake database with the real compare-and-set and ordering semantics): what is stored for the
 * visitor, what counts as delivered, and what reaches the browser.
 */
const details = timed([{ role: "user", content: `I want a check-up. ${NAME} ${PHONE}`, parts: null }]);

function setup() {
  return fakeDb({
    tables: { tenants: fullTenantRow, messages: details },
    rpc: { public_list_services: { data: [serviceRow] }, public_list_providers: { data: [providerRow] }, get_available_slots: { data: slotRows } },
  });
}
async function turn(f: ReturnType<typeof setup>, steps: Step[], onReply: (t: string) => string | undefined | void) {
  const res = await runAgent({
    tenantId: TENANT,
    conversationId: CONV,
    message: { type: "text", text: `${NAME} ${PHONE}` },
    locale: "en",
    onReply,
    deps: { db: f.db, model: scriptedModel(steps) },
  });
  return res;
}
const prepare = (over: Record<string, unknown> = {}): Step => ({ toolCalls: [{ name: "prepare_booking", input: { ...bookingArgs, ...over } }] });
const pendingOf = (f: ReturnType<typeof setup>) => (f.stateWrites.at(-1) as { pending?: { token: string; summary: string; delivered_message_id?: string } | null } | undefined)?.pending;

describe("item 3: a summary is attached to the stored message only if it is STILL the pending one", () => {
  it("a later failed prepare in the same turn clears pending, and the earlier summary is not stored as if it were open", async () => {
    const f = setup();
    let stored = "";
    const res = await turn(f, [prepare(), prepare({ phone: "+966555555555" }), { text: "Sorry, I need the right phone number." }], (t) => void (stored = t));
    await res.consumeStream();
    expect(pendingOf(f)).toBeNull();
    expect(stored).not.toContain("Booking summary");
    expect(stored).toContain("Sorry, I need the right phone number.");
  });
  it("a successful last prepare is stored with its summary and marked delivered with the id the persistence step returned", async () => {
    const f = setup();
    let stored = "";
    const res = await turn(f, [prepare(), { text: "Please confirm." }], (t) => {
      stored = t;
      return "99999999-9999-4999-8999-999999999999";
    });
    await res.consumeStream();
    expect(stored.startsWith("Booking summary:")).toBe(true);
    expect(pendingOf(f)?.delivered_message_id).toBe("99999999-9999-4999-8999-999999999999");
  });
  it("if persistence yields no message id, the pending summary stays undelivered (and so unusable)", async () => {
    const f = setup();
    const res = await turn(f, [prepare(), { text: "Please confirm." }], () => undefined);
    await res.consumeStream();
    expect(pendingOf(f)?.token).toBeTruthy();
    expect(pendingOf(f)?.delivered_message_id).toBeUndefined();
  });
});

describe("item 4: the token never reaches the browser or storage", () => {
  it("the prepare tool output has no token, and the UI stream chunks contain the summary but not the token", async () => {
    const f = setup();
    const res = await turn(f, [prepare(), { text: "Please confirm." }], () => "99999999-9999-4999-8999-999999999999");
    const chunks: string[] = [];
    const reader = res.toUIMessageStream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(JSON.stringify(value));
    }
    const wire = chunks.join("\n");
    const token = pendingOf(f)!.token;
    expect(wire).toContain("summary_text");
    expect(wire).not.toContain(token);
    expect(wire).not.toContain("confirmation_token");
    expect(wire).not.toMatch(/[\w-]{20,}\.[\w-]{30,}/);
  });
  it("token-shaped strings in the model's text are redacted before storage", async () => {
    const f = setup();
    let stored = "";
    const fake = `${"a".repeat(40)}.${"B".repeat(43)}`;
    const res = await turn(f, [{ text: `Your code is ${fake} thanks` }], (t) => void (stored = t));
    await res.consumeStream();
    expect(stored).toBe("Your code is [removed] thanks");
    expect(redactTokens("plain text, 17:30 and a.b")).toBe("plain text, 17:30 and a.b");
  });
});

describe("item 5: model text after a prepare may not contradict the server summary", () => {
  const summary = "Booking summary:\nService: Check-up (30 min)\nTime: 5:30 PM (17:30)\nPrice: 150 SAR\nDeposit: 50 SAR paid online";
  it.each([
    "Booked for free at 9am!",
    "Your visit is at 18:00.",
    "It costs 100 SAR only.",
    "الموعد الساعة 9:00 والسعر 80 ريال",
    "See you at 6 pm",
  ])("replaces %j with the neutral sentence", (t) => expect(guardPrepareText(t, summary)).toBe("Please review the summary above, then tap Confirm to book or Change to edit anything."));
  it.each(["Please confirm below.", "Is 5:30 PM right? The price is 150 SAR.", "Tap Confirm for the 17:30 slot.", "Dr Ahmed is great", "The deposit of 50 SAR is paid online."])("keeps %j", (t) => expect(guardPrepareText(t, summary)).toBe(t));
  it("an empty text gets the neutral sentence; an Arabic summary gets the Arabic one", () => {
    expect(guardPrepareText("", summary)).toMatch(/review the summary/);
    expect(guardPrepareText("الساعة 9:00", "ملخص الحجز:\nالوقت: 5:30 م (17:30)")).toMatch(/راجع الملخص/);
  });
  it("end to end: 'booked for free at 9am' next to the card is stored as summary + neutral sentence", async () => {
    const f = setup();
    let stored = "";
    const res = await turn(f, [prepare(), { text: "All set, booked for free at 9am!" }], (t) => void (stored = t));
    await res.consumeStream();
    expect(stored.startsWith("Booking summary:")).toBe(true);
    expect(stored).not.toContain("9am");
    expect(stored.endsWith("tap Confirm to book or Change to edit anything.")).toBe(true);
  });
});
