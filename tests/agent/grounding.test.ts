import { describe, expect, it } from "vitest";
import { cleanName, cleanPhone, emailGrounded, isPlaceholderEmail, nameGrounded, phoneGrounded, phoneKey } from "@/lib/agent/grounding";

describe("phone grounding", () => {
  const texts = ["اسمي سارة علي", "رقمي 0501234567 وشكرا"];
  it("accepts +966 / 00966 / 05 / 5 / spaced / dashed / Arabic-digit forms of the typed number", () => {
    for (const p of ["+966501234567", "00966501234567", "966501234567", "0501234567", "501234567", "+966 50 123 4567", "050-123-4567", "٠٥٠١٢٣٤٥٦٧", "+9660501234567"]) {
      expect(phoneGrounded(p, texts), p).toBe(true);
    }
  });
  it("accepts a number the visitor wrote in a spaced or Arabic-digit form, even next to a date", () => {
    expect(phoneGrounded("+966501234567", ["جوالي 050 123 4567"])).toBe(true);
    expect(phoneGrounded("0501234567", ["جوالي ٠٥٠١٢٣٤٥٦٧"])).toBe(true);
    expect(phoneGrounded("0501234567", ["on 2030-01-01 my number 0501234567"])).toBe(true);
    expect(phoneGrounded("0501234567", ["2030-01-01 0501234567"])).toBe(true);
  });
  it("rejects a number the visitor never wrote", () => {
    expect(phoneGrounded("+966500000000", texts)).toBe(false);
    expect(phoneGrounded("+966501234568", texts)).toBe(false);
    expect(phoneGrounded("+966501234567", ["no digits here"])).toBe(false);
    expect(phoneGrounded("1234", ["1234"])).toBe(false);
  });
  it("L1: whole digit runs only: no substring of a longer number, no digits borrowed from a date or time (the review's cases)", () => {
    expect(phoneGrounded("0500000000", ["my number is 0044 500000000"])).toBe(false);
    expect(phoneGrounded("2026111517", ["2026-11-15 17:30 please"])).toBe(false);
    expect(phoneGrounded("0534567890", ["order 1234567890123"])).toBe(false);
    expect(phoneGrounded("0501234567", ["ref 99501234567"])).toBe(false);
  });
  it("normalises to one key", () => {
    expect(new Set(["+966501234567", "00966501234567", "0501234567", "501234567", "+9660501234567"].map(phoneKey)).size).toBe(1);
  });
  it("cleanPhone shows Saudi mobiles in one form and keeps other numbers as typed", () => {
    expect(cleanPhone("0501234567")).toBe("+966501234567");
    expect(cleanPhone("+9660501234567")).toBe("+966501234567");
    expect(cleanPhone("00966 50 123 4567")).toBe("+966501234567");
    expect(cleanPhone("+44 7700 900123")).toBe("+447700900123");
  });
});

describe("email grounding and placeholders", () => {
  it("needs the exact address as its own token in a visitor message (case-insensitive)", () => {
    expect(emailGrounded("Sara@Mail-Co.dev", ["my email is sara@mail-co.dev thanks"])).toBe(true);
    expect(emailGrounded("sara@mail-co.dev", ["sara@mail-co.dev."])).toBe(true);
    expect(emailGrounded("sara@mail-co.dev", ["(sara@mail-co.dev)"])).toBe(true);
    expect(emailGrounded("test@example.com", ["my phone is 0501234567"])).toBe(false);
  });
  it("L1: token boundaries: no match inside a longer address", () => {
    expect(emailGrounded("sara@gmail.com", ["xsara@gmail.com"])).toBe(false);
    expect(emailGrounded("ali@gmail.co", ["ali@gmail.com"])).toBe(false);
    expect(emailGrounded("ali@gmail.com", ["ali@gmail.com.evil.io"])).toBe(false);
    expect(emailGrounded("ali@gmail.com", ["my.ali@gmail.com"])).toBe(false);
    expect(emailGrounded("ali@gmail.com", ["+ali@gmail.com"])).toBe(false);
  });
  it.each([
    "test@example.com", "TEST@EXAMPLE.COM", "a@example.org", "x@example.net", "me@test.com", "me@domain.com", "no-reply@shop.sa", "noreply@shop.sa", "test@shop.sa",
    "noemail@shop.sa", "user@localhost", "a@b.invalid", "a@b.test", "a@b.localhost", "none@shop.sa", "testing@shop.sa",
    "a@exampIe.com", "a@examp1e.com", "a@example。com", "a@еxample.com",
  ])("flags the placeholder %s", (e) => expect(isPlaceholderEmail(e)).toBe(true));
  it.each(["sara.ali@gmail.com", "omar@clinic-nour.sa", "n.alharbi@outlook.com", "test+1@gmail.com", "info@x.sa", "admin@clinic.sa", "test.user@shop.sa", "user@mail.com", "a@example.co", "x@mailinator.com"])(
    "L2: keeps the real address %s",
    (e) => expect(isPlaceholderEmail(e)).toBe(false),
  );
  it("a malformed address is not a placeholder (the format check rejects it)", () => {
    expect(isPlaceholderEmail("not-an-email")).toBe(false);
  });
});

describe("name grounding", () => {
  it("matches case-insensitively and with Arabic normalisation; single-word names work", () => {
    expect(nameGrounded("Sara Ali", ["hi, I am sara ali"])).toBe(true);
    expect(nameGrounded("فاطمة الزهراء", ["اسمي فاطمَه الزهراء"])).toBe(true);
    expect(nameGrounded("أحمد", ["انا احمد"])).toBe(true);
    expect(nameGrounded("Omar", ["Omar"])).toBe(true);
  });
  it("rejects a name the visitor never wrote", () => {
    expect(nameGrounded("Test User", ["I want a check-up", "0501234567"])).toBe(false);
    expect(nameGrounded("Sara Ali", ["my name is Omar"])).toBe(false);
    expect(nameGrounded("", ["x"])).toBe(false);
  });
  it("L1: the FULL name as whole words: no prefix, no words scattered over several messages, no command words", () => {
    expect(nameGrounded("Moh", ["I am Mohammed"])).toBe(false);
    expect(nameGrounded("Sara Ali", ["Sara", "Ali"])).toBe(false);
    expect(nameGrounded("Book Now", ["book now please"])).toBe(false);
    expect(nameGrounded("yes ok", ["yes ok"])).toBe(false);
    expect(nameGrounded("Sara Mohammed Ali", ["Sara Ali"])).toBe(false);
  });
  it("cleanName turns punctuation runs into single spaces", () => {
    expect(cleanName("SARA...ALI")).toBe("SARA ALI");
    expect(cleanName("  Sara   Al-Harbi ")).toBe("Sara Al-Harbi");
    expect(cleanName("O'Brien")).toBe("O'Brien");
  });
});
