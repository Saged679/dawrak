import { describe, expect, it } from "vitest";
import { instantToLocal, localToInstant, parseClock } from "@/lib/agent/local-time";
import { normalizeTime } from "@/lib/agent/tool-input";

describe("localToInstant: the server converts business-local date+time, never the model", () => {
  it("17:30 in Asia/Riyadh stays 17:30 local (14:30Z), not 20:30", () => {
    const iso = localToInstant("2026-11-15", "17:30", "Asia/Riyadh");
    expect(iso).toBe("2026-11-15T14:30:00.000Z");
    expect(instantToLocal(iso!, "Asia/Riyadh")).toMatchObject({ date: "2026-11-15", time: "17:30" });
  });
  it("handles midnight boundaries in both directions", () => {
    expect(localToInstant("2026-11-15", "00:00", "Asia/Riyadh")).toBe("2026-11-14T21:00:00.000Z");
    expect(localToInstant("2026-11-15", "23:30", "Asia/Riyadh")).toBe("2026-11-15T20:30:00.000Z");
    expect(instantToLocal("2026-11-14T21:00:00.000Z", "Asia/Riyadh")).toMatchObject({ date: "2026-11-15", time: "00:00" });
    expect(localToInstant("2026-11-15", "00:00", "UTC")).toBe("2026-11-15T00:00:00.000Z");
  });
  it("works for DST-less zones with other offsets", () => {
    expect(localToInstant("2026-07-01", "09:00", "Asia/Dubai")).toBe("2026-07-01T05:00:00.000Z");
    expect(localToInstant("2026-01-01", "09:00", "Africa/Cairo")).toBe("2026-01-01T07:00:00.000Z");
  });
  it("proves the conversion with a DST zone (Europe/Berlin): CEST in July, CET in December", () => {
    expect(localToInstant("2026-07-15", "17:30", "Europe/Berlin")).toBe("2026-07-15T15:30:00.000Z");
    expect(localToInstant("2026-12-15", "17:30", "Europe/Berlin")).toBe("2026-12-15T16:30:00.000Z");
    expect(instantToLocal("2026-07-15T15:30:00.000Z", "Europe/Berlin")).toMatchObject({ date: "2026-07-15", time: "17:30" });
  });
  it("rejects wall-clock times that do not exist (spring-forward gap) and invalid input", () => {
    expect(localToInstant("2026-03-29", "02:30", "Europe/Berlin")).toBeNull();
    expect(localToInstant("2026-02-30", "10:00", "Asia/Riyadh")).toBeNull();
    expect(localToInstant("2026-02-10", "24:00", "Asia/Riyadh")).toBeNull();
    expect(localToInstant("2026-02-10", "9:60", "Asia/Riyadh")).toBeNull();
    expect(localToInstant("2026-02-10", "noon", "Asia/Riyadh")).toBeNull();
  });
  it("parseClock reads HH:mm only", () => {
    expect(parseClock("17:30")).toBe(1050);
    expect(parseClock("7:05")).toBe(425);
    expect(parseClock("25:00")).toBeNull();
  });
});

describe("normalizeTime tolerates how models write a clock time", () => {
  it.each([
    ["17:30", "17:30"], ["17:30:00", "17:30"], ["5:30 PM", "17:30"], ["5:30pm", "17:30"], ["9am", "09:00"], ["12:00 AM", "00:00"], ["12:15 PM", "12:15"],
    ["9:05", "09:05"], ["09.30", "09:30"],
  ])("%s -> %s", (i, o) => expect(normalizeTime(i)).toBe(o));
  it.each(["25:00", "13:00 PM", "noon", "17:61"])("leaves %s for the strict schema to reject", (i) => expect(normalizeTime(i)).toBe(i));
});
