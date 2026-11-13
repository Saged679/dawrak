import { describe, expect, it } from "vitest";
import { noShowRate } from "@/lib/dashboard/queries";
import {
  blockGeometry,
  dayRange,
  gridBounds,
  isDateKey,
  localParts,
  weekStartKey,
  zonedToUtc,
} from "@/lib/dashboard/time";

describe("tenant time zone helpers", () => {
  it("converts local wall time in Riyadh (UTC+3) to UTC", () => {
    expect(zonedToUtc("2026-11-15", 9 * 60 + 30, "Asia/Riyadh").toISOString()).toBe(
      "2026-11-15T06:30:00.000Z",
    );
  });

  it("handles zones with daylight saving time", () => {
    expect(zonedToUtc("2026-07-01", 0, "America/New_York").toISOString()).toBe("2026-07-01T04:00:00.000Z");
    expect(zonedToUtc("2026-12-01", 0, "America/New_York").toISOString()).toBe("2026-12-01T05:00:00.000Z");
  });

  it("builds a local day range and reads local parts back", () => {
    expect(dayRange("2026-11-15", "Asia/Riyadh")).toEqual({
      from: "2026-11-14T21:00:00.000Z",
      to: "2026-11-15T21:00:00.000Z",
    });
    expect(localParts("2026-11-14T21:30:00.000Z", "Asia/Riyadh")).toEqual({
      dateKey: "2026-11-15",
      minutes: 30,
    });
  });

  it("starts the week on Sunday", () => {
    expect(weekStartKey("2026-11-15")).toBe("2026-11-15"); // Sunday
    expect(weekStartKey("2026-11-21")).toBe("2026-11-15"); // Saturday
    expect(weekStartKey("2026-11-13")).toBe("2026-11-08"); // Friday
  });

  it("validates date keys", () => {
    expect(isDateKey("2026-11-15")).toBe(true);
    expect(isDateKey("2026-02-30")).toBe(false);
    expect(isDateKey("15-11-2026")).toBe(false);
    expect(isDateKey(undefined)).toBe(false);
  });
});

describe("calendar geometry", () => {
  it("positions a block by minutes from the grid start", () => {
    expect(blockGeometry(9 * 60 + 30, 10 * 60 + 30, 9 * 60, 72)).toEqual({ top: 36, height: 70 });
  });
  it("never lets a block collapse", () => {
    expect(blockGeometry(540, 545, 540, 72).height).toBe(24);
  });
  it("widens the grid to fit opening hours and appointments", () => {
    expect(gridBounds([{ start: 9 * 60, end: 21 * 60 }], [])).toEqual({ startHour: 9, endHour: 21 });
    expect(gridBounds([{ start: 9 * 60, end: 21 * 60 }], [{ startMin: 8 * 60 + 15, endMin: 22 * 60 + 5 }])).toEqual({
      startHour: 8,
      endHour: 23,
    });
    expect(gridBounds([], [])).toEqual({ startHour: 9, endHour: 21 });
  });
});

describe("no-show rate", () => {
  it("is null with no finished appointments and a ratio otherwise", () => {
    expect(noShowRate(0, 0)).toBeNull();
    expect(noShowRate(9, 1)).toBeCloseTo(0.1);
  });
});
