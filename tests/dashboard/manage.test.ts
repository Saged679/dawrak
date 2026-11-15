import { describe, expect, it } from "vitest";
import { formatHijri } from "@/components/booking/dates";
import { checkViolationField, mapStaffError, mapWriteError } from "@/lib/dashboard/errors";
import {
  checkTimeOff,
  cleanSearch,
  customerSearchFilter,
  localDateTimeToUtc,
  providerInput,
  readableOn,
  serviceInput,
  settingsSchema,
  summarizeVisits,
  validateWeek,
} from "@/lib/dashboard/manage";
import { contrastRatio } from "@/lib/db/brand";

describe("validateWeek", () => {
  const day = (weekday: number, ...r: [string, string][]) => ({
    weekday,
    ranges: r.map(([start, end]) => ({ start, end })),
  });

  it("accepts split shifts and touching ranges, and sorts them", () => {
    const res = validateWeek([day(1, ["16:00", "20:00"], ["09:00", "13:00"]), day(2, ["09:00", "12:00"], ["12:00", "15:00"])]);
    expect(res).toEqual({
      ok: true,
      rows: [
        { weekday: 1, start: "09:00", end: "13:00" },
        { weekday: 1, start: "16:00", end: "20:00" },
        { weekday: 2, start: "09:00", end: "12:00" },
        { weekday: 2, start: "12:00", end: "15:00" },
      ],
    });
  });

  it("rejects an end that is not after the start (equal or inverted)", () => {
    expect(validateWeek([day(0, ["17:00", "09:00"])])).toEqual({ ok: false, code: "hours_inverted", weekday: 0 });
    expect(validateWeek([day(3, ["09:00", "09:00"])])).toEqual({ ok: false, code: "hours_inverted", weekday: 3 });
  });

  it("rejects overlapping ranges on one day", () => {
    expect(validateWeek([day(4, ["09:00", "13:00"], ["12:30", "16:00"])])).toEqual({
      ok: false,
      code: "hours_overlap",
      weekday: 4,
    });
  });

  it("rejects malformed times and duplicate weekdays", () => {
    expect(validateWeek([day(1, ["9:00", "10:00"])])).toMatchObject({ ok: false, code: "hours_invalid" });
    expect(validateWeek([day(1, ["09:00", ""])])).toMatchObject({ ok: false, code: "hours_invalid" });
    expect(validateWeek([day(1, ["09:00", "10:00"]), day(1, ["11:00", "12:00"])])).toMatchObject({
      ok: false,
      code: "hours_invalid",
    });
  });

  it("allows an empty week (all days off)", () => {
    expect(validateWeek([])).toEqual({ ok: true, rows: [] });
  });
});

describe("time off in the tenant timezone", () => {
  it("reads wall-clock input in the tenant zone", () => {
    // Riyadh is UTC+3 all year.
    expect(localDateTimeToUtc("2026-11-13T09:30", "Asia/Riyadh")?.toISOString()).toBe("2026-11-13T06:30:00.000Z");
    expect(localDateTimeToUtc("2026-11-13T09:30", "UTC")?.toISOString()).toBe("2026-11-13T09:30:00.000Z");
  });

  it("rejects bad dates, inverted and absurdly long ranges", () => {
    expect(localDateTimeToUtc("2026-02-30T09:00", "Asia/Riyadh")).toBeNull();
    expect(localDateTimeToUtc("2026-11-13 09:00", "Asia/Riyadh")).toBeNull();
    expect(checkTimeOff("2026-11-14T09:00", "2026-11-13T09:00", "Asia/Riyadh").ok).toBe(false);
    expect(checkTimeOff("2026-11-13T09:00", "2026-11-13T09:00", "Asia/Riyadh").ok).toBe(false);
    expect(checkTimeOff("2026-01-01T00:00", "2028-01-01T00:00", "Asia/Riyadh").ok).toBe(false);
    expect(checkTimeOff("2026-11-13T00:00", "2026-11-14T00:00", "Asia/Riyadh")).toEqual({
      ok: true,
      startsAt: "2026-11-12T21:00:00.000Z",
      endsAt: "2026-11-13T21:00:00.000Z",
    });
  });
});

describe("service and provider schemas", () => {
  const base = {
    name_ar: "كشف",
    name_en: "Check-up",
    description_ar: "",
    description_en: " Full exam ",
    duration_min: "30",
    buffer_min: "10",
    price: "150.50",
    is_active: true,
    provider_ids: [],
  };

  it("coerces numeric strings and blanks optional text to null", () => {
    const r = serviceInput.parse(base);
    expect(r).toMatchObject({ duration_min: 30, buffer_min: 10, price: 150.5, description_ar: null, description_en: "Full exam" });
  });

  it.each([
    ["negative price", { price: "-1" }],
    ["exponent price", { price: "1e3" }],
    ["three decimals", { price: "1.234" }],
    ["zero duration", { duration_min: "0" }],
    ["huge duration", { duration_min: "9999" }],
    ["empty name", { name_en: "  " }],
    ["bad provider id", { provider_ids: ["nope"] }],
  ])("rejects %s", (_n, over) => {
    expect(serviceInput.safeParse({ ...base, ...over }).success).toBe(false);
  });

  it("requires both names for a provider", () => {
    expect(providerInput.safeParse({ name_ar: "د", name_en: "", is_active: true }).success).toBe(false);
    expect(providerInput.safeParse({ name_ar: "د", name_en: "Dr", title_ar: "", bio_en: "", is_active: true, bio_ar: "", title_en: "" }).success).toBe(true);
  });
});

describe("settings schema", () => {
  const schema = settingsSchema({ timezone: "Asia/Riyadh", currency: "SAR" });
  const ok = {
    name_ar: "عيادة",
    name_en: "Clinic",
    timezone: "Asia/Riyadh",
    currency: "SAR",
    deposit_enabled: true,
    deposit_type: "percent" as const,
    deposit_value: "20",
    logo_url: "",
    brand_color: "#0F766E",
  };

  it("accepts a valid form and normalises blanks and colour case", () => {
    expect(schema.parse(ok)).toMatchObject({ deposit_value: 20, logo_url: null, brand_color: "#0f766e" });
  });

  it.each([
    ["unknown time zone (could break the booking functions)", { timezone: "Mars/Base" }],
    ["unlisted currency", { currency: "XXX" }],
    ["http logo", { logo_url: "http://example.com/a.png" }],
    ["javascript logo", { logo_url: "javascript:alert(1)" }],
    ["short colour", { brand_color: "#fff" }],
    ["named colour", { brand_color: "red" }],
    ["percent above 100", { deposit_value: "101" }],
    ["deposit on with zero", { deposit_value: "0" }],
    ["bad enum", { deposit_type: "weird" }],
  ])("rejects %s", (_n, over) => {
    expect(schema.safeParse({ ...ok, ...over }).success).toBe(false);
  });

  it("keeps a tenant's existing value selectable even if it is not in the list", () => {
    const s = settingsSchema({ timezone: "Asia/Tehran", currency: "IRR" });
    expect(s.safeParse({ ...ok, timezone: "Asia/Tehran", currency: "IRR" }).success).toBe(true);
  });

  it("allows deposit off with 0", () => {
    expect(schema.safeParse({ ...ok, deposit_enabled: false, deposit_value: "0" }).success).toBe(true);
  });
});

describe("readableOn", () => {
  it("keeps colours that already work and picks the right text colour", () => {
    expect(readableOn("#0f766e")).toEqual({ bg: "#0f766e", fg: "#ffffff" });
    expect(readableOn("#2549d1")).toEqual({ bg: "#2549d1", fg: "#ffffff" });
    expect(readableOn("#fdebc8")).toEqual({ bg: "#fdebc8", fg: "#101c3a" });
    expect(readableOn("#f2a93b")).toEqual({ bg: "#f2a93b", fg: "#101c3a" });
    expect(readableOn("garbage")).toEqual({ bg: "#2549d1", fg: "#ffffff" });
  });
  it("reaches 4.5:1 for every colour on a coarse RGB grid, including mid-tones", () => {
    let worst = 21;
    for (let r = 0; r < 256; r += 15) {
      for (let g = 0; g < 256; g += 15) {
        for (let b = 0; b < 256; b += 15) {
          const hex = "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
          const { bg, fg } = readableOn(hex);
          worst = Math.min(worst, contrastRatio(fg, bg));
        }
      }
    }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });
});

describe("customer search and stats", () => {
  it("strips characters that are special in a PostgREST filter", () => {
    expect(cleanSearch('a,b)(c%d*e"f')).toBe("a b c d e f");
    expect(cleanSearch("  ")).toBe("");
    expect(cleanSearch(undefined)).toBe("");
    expect(cleanSearch("x".repeat(100))).toHaveLength(60);
  });

  it("builds no filter for blank input and an or-filter otherwise", () => {
    expect(customerSearchFilter("")).toBeNull();
    expect(customerSearchFilter("sara")).toBe("full_name.ilike.*sara*,email.ilike.*sara*,phone.ilike.*sara*");
  });

  it("also matches a local number typed with a leading 0 against +966 storage", () => {
    expect(customerSearchFilter("0501234567")).toContain("phone.ilike.*501234567*");
  });

  it("counts completed visits, no-shows and the latest completed visit", () => {
    expect(
      summarizeVisits([
        { status: "completed", starts_at: "2026-01-01T10:00:00Z" },
        { status: "completed", starts_at: "2026-03-01T10:00:00Z" },
        { status: "no_show", starts_at: "2026-04-01T10:00:00Z" },
        { status: "cancelled", starts_at: "2026-05-01T10:00:00Z" },
        { status: "confirmed", starts_at: "2026-12-01T10:00:00Z" },
      ]),
    ).toEqual({ visits: 2, noShows: 1, lastVisit: "2026-03-01T10:00:00Z" });
    expect(summarizeVisits([])).toEqual({ visits: 0, noShows: 0, lastVisit: null });
  });
});

describe("check violations (23514)", () => {
  const len = (c: string) => ({ code: "23514", message: `new row for relation "x" violates check constraint "${c}"` });

  it("map to the too-long message for write and staff errors", () => {
    expect(mapWriteError(len("services_name_ar_len"))).toBe("too_long");
    expect(mapStaffError(len("appointments_notes_len"))).toBe("too_long");
    expect(mapWriteError({ code: "23502", message: "null value" })).toBe("invalid");
  });

  it("names the column when the constraint name gives it away", () => {
    expect(checkViolationField(len("services_name_ar_len"))).toBe("name_ar");
    expect(checkViolationField(len("providers_bio_en_len"))).toBe("bio_en");
    expect(checkViolationField(len("time_off_reason_len"))).toBe("reason");
    expect(checkViolationField(len("tenants_logo_url_len"))).toBe("logo_url");
    expect(checkViolationField(len("appointments_notes_len"))).toBe("notes");
    expect(checkViolationField(len("customers_phone_len"))).toBe("phone");
  });

  it("returns null for other constraints and non-errors", () => {
    expect(checkViolationField(len("tenants_deposit_value_check"))).toBeNull();
    expect(checkViolationField(len("mystery_col_len"))).toBeNull();
    expect(checkViolationField({ code: "23514", message: "check" })).toBeNull();
    expect(checkViolationField(null)).toBeNull();
  });
});

describe("mapWriteError", () => {
  it("tells the demo trigger apart from a plain permission error (both are 42501)", () => {
    expect(mapWriteError({ code: "42501", message: "demo_readonly" })).toBe("demo_readonly");
    expect(mapWriteError({ code: "54000", message: "demo_limit" })).toBe("demo_limit");
    for (const c of ["kb_documents_content_len", "kb_documents_title_len", "kb_chunks_content_len"]) {
      expect(mapWriteError({ code: "23514", message: `new row violates check constraint "${c}"` }), c).toBe("too_long");
    }
    expect(mapWriteError({ code: "42501", message: "new row violates row-level security policy" })).toBe("forbidden");
    expect(mapWriteError({ code: "42501", message: "permission denied for table tenants" })).toBe("forbidden");
    expect(mapWriteError({ code: "P0001", message: "forbidden" })).toBe("forbidden");
  });

  it("maps limits and constraint violations", () => {
    expect(mapWriteError({ code: "54000", message: "demo_limit" })).toBe("demo_limit");
    expect(mapWriteError({ code: "23505", message: "duplicate key" })).toBe("duplicate");
    expect(mapWriteError({ code: "23514", message: "check constraint" })).toBe("too_long");
    expect(mapWriteError({ code: "23503", message: "fk" })).toBe("invalid");
    expect(mapWriteError({ code: "XX000", message: "boom" })).toBe("generic");
    expect(mapWriteError(null)).toBe("generic");
  });
});

describe("Hijri date per locale", () => {
  it("renders Arabic script only for ar and Latin text for en", () => {
    const ar = formatHijri("2026-11-13", undefined, "ar");
    const en = formatHijri("2026-11-13", undefined, "en");
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(en).not.toMatch(/[؀-ۿ]/);
    expect(en).toMatch(/1448/);
  });

  it("keeps the Arabic default for existing callers (public booking page)", () => {
    expect(formatHijri("2026-11-13")).toBe(formatHijri("2026-11-13", undefined, "ar"));
  });
});
