import { describe, expect, it } from "vitest";
import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";
import {
  bookingInputSchema,
  mapBookingError,
  normalizePhone,
} from "./schema";

describe("normalizePhone", () => {
  it.each([
    ["0501234567", "+966501234567"],
    ["501234567", "+966501234567"],
    ["+966 50 123 4567", "+966501234567"],
    ["00966501234567", "+966501234567"],
    ["٠٥٠١٢٣٤٥٦٧", "+966501234567"],
    ["01012345678", "+201012345678"],
    ["+20 101 234 5678", "+201012345678"],
    ["01512345678", "+201512345678"],
  ])("accepts %s", (input, out) => {
    expect(normalizePhone(input)).toBe(out);
  });

  it.each(["", "abc", "0401234567", "0601234567", "01312345678", "+441234567890", "05012345"])(
    "rejects %s",
    (input) => {
      expect(normalizePhone(input)).toBeNull();
    },
  );
});

describe("bookingInputSchema", () => {
  const base = {
    slug: "demo-clinic",
    locale: "ar",
    serviceId: "e1000000-0000-4000-8000-000000000001",
    providerId: "f1000000-0000-4000-8000-000000000001",
    startsAt: "2026-11-20T06:00:00+00:00",
    fullName: "Sara Ali",
    phone: "0501234567",
    email: "",
  };

  it("normalizes phone and drops an empty email", () => {
    const r = bookingInputSchema.parse(base);
    expect(r.phone).toBe("+966501234567");
    expect(r.email).toBeUndefined();
  });

  it("rejects bad phone, name and email", () => {
    expect(bookingInputSchema.safeParse({ ...base, phone: "123" }).success).toBe(false);
    expect(bookingInputSchema.safeParse({ ...base, fullName: "a" }).success).toBe(false);
    expect(bookingInputSchema.safeParse({ ...base, email: "nope" }).success).toBe(false);
    expect(bookingInputSchema.safeParse({ ...base, slug: "Bad Slug" }).success).toBe(false);
  });
});

describe("mapBookingError", () => {
  it("maps the database error codes", () => {
    expect(mapBookingError({ code: "23P01", message: "slot_taken" })).toBe("slot_taken");
    expect(mapBookingError({ code: "P0001", message: "too_far" })).toBe("too_far");
    expect(mapBookingError({ code: "P0001", message: "too_many_bookings" })).toBe("too_many_bookings");
    expect(mapBookingError({ message: "invalid_phone" })).toBe("invalid");
    expect(mapBookingError({ message: "boom" })).toBe("generic");
  });
});

function keys(o: unknown, prefix = ""): string[] {
  if (typeof o !== "object" || o === null) return [prefix];
  return Object.entries(o).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe("messages", () => {
  it("ar and en have identical key trees", () => {
    expect(keys(ar).sort()).toEqual(keys(en).sort());
  });
});

describe("mapBookingError transient errors", () => {
  it("maps deadlock (40P01) and serialization failure (40001) to try_again", () => {
    expect(mapBookingError({ code: "40P01", message: "deadlock detected" })).toBe("try_again");
    expect(mapBookingError({ code: "40001", message: "could not serialize access" })).toBe("try_again");
  });
  it("keeps 23P01 as slot_taken", () => {
    expect(mapBookingError({ code: "23P01", message: "conflicting key value violates exclusion constraint" })).toBe("slot_taken");
  });
});
