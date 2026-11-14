import { describe, expect, it } from "vitest";
import { isAffirmative } from "@/lib/agent/affirmative";

describe("isAffirmative: accepted (explicit, plain confirmations)", () => {
  it.each([
    "نعم", "أكيد", "أكد", "تأكيد", "أكد الحجز", "تمام", "موافق", "ماشي", "يلا", "ابشر", "زين", "طيب أكد", "ايوه", "ايوا", "إيوه", "اوكي",
    "ايوه تمام", "أيوة أكد الحجز", "نعم احجز", "ايوه أكد", "تمام شكرا", "ايوه اكد لو سمحت".replace(" لو", ""),
    "نَعَم", "تـأكـيـد", "ايوووووه", "تمااااام", "أكيييد!!!", "تأكيد.", "...ايوه", "نعم 👍", "👍", "✅", "تمام ✅",
    "yes", "Yes", "YES!", "yeah", "yep", "ok", "okay", "OK.", "confirm", "Confirm", "go ahead", "book it", "ok book it", "sure", "yes please", "yessss", "okkkk",
    "yes, go ahead", "ok thanks", "ｙｅｓ",
  ])("accepts %j", (t) => {
    expect(isAffirmative(t, "en")).toBe(true);
  });

  it("accepts the widget quick-reply labels in both languages", () => {
    expect(isAffirmative("تأكيد", "ar")).toBe(true);
    expect(isAffirmative("Confirm", "en")).toBe(true);
    expect(isAffirmative("تأكيد", "ar", "cancel_booking")).toBe(true);
  });
});

describe("isAffirmative: rejected (negations, hedges, conditionals, new information, questions, ambiguous tokens)", () => {
  it.each([
    // plain refusals and changes
    "لا", "لأ", "لاا", "مو", "مب", "ما ابغى", "ما أبي", "مش عايز", "لا تحجز", "لا شكرا", "لسا", "غير", "غيّر", "بس غير الوقت", "تعديل",
    "ايوه بس", "ايوه بس غيّر الوقت", "ايوه لكن", "تمام بس الساعة 5", "ايوه الساعة 5", "ايوه اسمي محمد", "ايوه بس ابغى دكتور ثاني",
    "no", "No", "nope", "wait", "Wait!", "not yet", "yes but", "yes but change the time", "yeah no", "ok but", "hold on", "stop", "don't", "dont book",
    "change", "Change", "change it", "cancel", "maybe", "I think so", "not sure", "later", "yes my name is Omar", "yes at 6pm", "ok 18:00",
    // questions
    "ايوه؟", "تمام؟", "yes?", "are you sure?", "هل أكد؟", "متى؟", "كم السعر", "ايوه كم السعر", "ممكن اشوف الاسعار",
    // empty / noise / negative emoji
    "", "   ", "!!!", "👎", "❌", "yes 👎", "تمام ❌",
    // the adversarial review's proven false positives
    "تمام الغاء الحجز", "اوكي الغاء", "ok cancellation", "yes cancellation of the booking", "confirm the cancellation", "ثبت الالغاء", "نفذ الالغاء",
    "اي موعد", "اي حجز", "ممكن احجز", "ok لو", "تمام لو", "يعني تمام", "ان شاء الله تمام", "ان شاء الله",
    "🙏", "🤝", "k", "kk", "kkk", "اه", "right", "fine", "good", "great thanks", "perfect thank you",
    // conditionals, hedges, other speakers, extra actions
    "اكيد لا", "تمام لا", "yes if cheaper", "he said yes", "yes also cancel all other bookings", "sure thing", "that is fine for me", "do it", "now go",
    "sure book the appointment for me now please thanks", "ok no", "ok_no", "yes_please", "yes1", "ok 2", "book it for me now",
    // lookalike and invisible characters
    "уes", "y‍es", "ok⁠no", "ok no", "yes\nno",
    // only polite filler, or a long message
    "thanks", "please", "شكرا", "الحجز", "حجز", "لا مانع", "ايوه ايوه ايوه ايوه ايوه ايوه ايوه ايوه ايوه", "x".repeat(200),
  ])("rejects %j", (t) => {
    expect(isAffirmative(t, "ar")).toBe(false);
  });

  it("a long message with new information is never an affirmative", () => {
    expect(isAffirmative("ايوه تمام بس ممكن نخليه يوم الخميس الساعة 6 مساء بدل الأربعاء", "ar")).toBe(false);
    expect(isAffirmative("yes confirm but please make it at 6pm on Thursday instead of Wednesday", "en")).toBe(false);
  });

  it("is not fooled by non-string input", () => {
    expect(isAffirmative(undefined as unknown as string, "en")).toBe(false);
    expect(isAffirmative(null as unknown as string, "en")).toBe(false);
  });
});

describe("isAffirmative is action-aware: cancellation words only confirm a cancellation", () => {
  it.each(["اكد الالغاء", "تمام الغاء", "اوكي الغاء", "confirm the cancellation", "yes cancel", "ok cancellation", "نعم الغاء"])("%j: yes for cancel_booking, no for booking and reschedule", (t) => {
    expect(isAffirmative(t, "ar", "cancel_booking")).toBe(true);
    expect(isAffirmative(t, "ar", "create_booking")).toBe(false);
    expect(isAffirmative(t, "ar", "reschedule_booking")).toBe(false);
    expect(isAffirmative(t, "ar")).toBe(false);
  });
  it("a cancellation still needs a strong or weak affirmative: the filler alone is not consent", () => {
    for (const t of ["الغاء", "الالغاء", "cancel", "cancellation"]) expect(isAffirmative(t, "ar", "cancel_booking"), t).toBe(false);
  });
});

// ---- Round 2: the cancel lexicon, other-action words, emoji/marks/repetition nits ----------------------------------
describe("round 2: booking words never confirm a CANCELLATION", () => {
  it.each(["احجز الموعد", "اكد الحجز", "تأكيد الحجز", "نعم الموعد", "book it", "confirm the booking", "confirm my appointment", "نعم احجز", "yes book it", "احجز", "ok book", "confirm appointment"])(
    "%j does not confirm a cancel_booking",
    (t) => expect(isAffirmative(t, "ar", "cancel_booking")).toBe(false),
  );
  it.each(["نعم الغي", "ايوه الغ", "yes cancel it", "confirm cancellation", "تأكيد الالغاء", "اكد الالغاء", "نعم الغيه", "تأكيد", "Confirm", "confirm", "نعم", "yes", "اكيد الغي", "ok cancel", "تمام الغي"])(
    "%j confirms a cancel_booking",
    (t) => expect(isAffirmative(t, "ar", "cancel_booking")).toBe(true),
  );
  it.each(["لا تلغي", "ما ابغى الغاء", "مو الحين الغي", "no cancel", "dont cancel", "don't cancel it", "لا تلغي الحجز", "خلي الحجز", "لا الغاء", "ok keep", "لا", "تعديل", "Change", "yes cancel but later", "نعم الغي بعدين"])(
    "%j never confirms a cancel_booking",
    (t) => expect(isAffirmative(t, "ar", "cancel_booking")).toBe(false),
  );
});

describe("round 2: the three actions' accept lists still pass", () => {
  it.each(["تأكيد", "Confirm", "نعم احجز", "ايوه أكد", "ok book it", "تمام", "yes", "confirm"])("%j confirms a booking and a reschedule", (t) => {
    expect(isAffirmative(t, "ar", "create_booking")).toBe(true);
    expect(isAffirmative(t, "ar", "reschedule_booking")).toBe(true);
  });
  it.each(["احجز الموعد", "اكد الحجز", "تأكيد الحجز", "confirm the booking", "book it", "ok confirm appointment"])("%j confirms a booking and a reschedule (booking words are theirs)", (t) => {
    expect(isAffirmative(t, "ar", "create_booking")).toBe(true);
    expect(isAffirmative(t, "ar", "reschedule_booking")).toBe(true);
  });
  it.each(["الغي", "يلا الغي", "نعم الغي", "yes cancel", "ok cancel it", "تمام الغاء", "confirm cancellation", "الغاء"])("%j never confirms a booking or a reschedule (cancel words are not theirs)", (t) => {
    expect(isAffirmative(t, "ar", "create_booking")).toBe(false);
    expect(isAffirmative(t, "ar", "reschedule_booking")).toBe(false);
  });
});

describe("round 2 nits: emoji sequences, combining marks, repetition", () => {
  it.each(["🙄👍", "😂 ok", "👍😂", "🙄 تمام", "ok 😒", "✅🙄"])("%j is not a confirmation", (t) => expect(isAffirmative(t, "en", "create_booking")).toBe(false));
  it.each(["yes\u0336", "y\u0336es", "ok\u0338", "yes\u0301", "تمام\u0336", "yes\u20E0"])("combining or strike-through marks (%j) are not a plain yes", (t) => expect(isAffirmative(t, "en", "create_booking")).toBe(false));
  it("Arabic diacritics and the plain thumbs-up still work", () => {
    expect(isAffirmative("نَعَم", "ar", "create_booking")).toBe(true);
    expect(isAffirmative("👍", "ar", "create_booking")).toBe(true);
    expect(isAffirmative("✅ تمام", "ar", "create_booking")).toBe(true);
  });
  it("one word more than twice, or a pile of acknowledgements, is not consent", () => {
    expect(isAffirmative("اوكي اوكي اوكي اوكي اوكي اوكي اوكي", "ar", "create_booking")).toBe(false);
    expect(isAffirmative("اوكي اوكي اوكي", "ar", "create_booking")).toBe(false);
    expect(isAffirmative("اوكي اوكي", "ar", "create_booking")).toBe(true);
    expect(isAffirmative("تمام اوكي ماشي موافق", "ar", "create_booking")).toBe(false);
    expect(isAffirmative("yes yes yes", "en", "create_booking")).toBe(false);
    expect(isAffirmative("ok ok", "en", "create_booking")).toBe(true);
  });
});
