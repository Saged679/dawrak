import { describe, expect, it } from "vitest";
import { computeDepositMinor, majorToMinor, minorToMajor } from "./deposit";

describe("computeDepositMinor", () => {
  it("fixed amount in SAR becomes halalas", () => {
    expect(computeDepositMinor(300, { type: "fixed", value: 50 })).toBe(5000);
    expect(computeDepositMinor(300, { type: "fixed", value: 49.99 })).toBe(4999);
  });

  it("percentage of the price, rounded to the halala", () => {
    expect(computeDepositMinor(300, { type: "percent", value: 20 })).toBe(6000);
    expect(computeDepositMinor(99.99, { type: "percent", value: 33 })).toBe(Math.round(9999 * 0.33));
    expect(computeDepositMinor(10.01, { type: "percent", value: 12.5 })).toBe(Math.round((1001 * 12.5) / 100));
  });

  it("never exceeds the price", () => {
    expect(computeDepositMinor(100, { type: "fixed", value: 500 })).toBe(10000);
    expect(computeDepositMinor(100, { type: "percent", value: 250 })).toBe(10000);
  });

  it("never negative and tolerant of junk", () => {
    expect(computeDepositMinor(100, { type: "fixed", value: -5 })).toBe(0);
    expect(computeDepositMinor(100, { type: "percent", value: -10 })).toBe(0);
    expect(computeDepositMinor(-100, { type: "fixed", value: 10 })).toBe(0);
    expect(computeDepositMinor(Number.NaN, { type: "fixed", value: 10 })).toBe(0);
    expect(computeDepositMinor(100, { type: "fixed", value: Number.NaN })).toBe(0);
    expect(computeDepositMinor(100, { type: "fixed", value: Infinity })).toBe(0);
    expect(computeDepositMinor(100, { type: null, value: 10 })).toBe(0);
    expect(computeDepositMinor(100, { type: "fixed", value: null })).toBe(0);
    expect(computeDepositMinor(0, { type: "percent", value: 50 })).toBe(0);
  });

  it("is an integer even for awkward floats", () => {
    const v = computeDepositMinor(0.1 + 0.2, { type: "percent", value: 33.333 });
    expect(Number.isInteger(v)).toBe(true);
  });

  it("converts between major and minor units", () => {
    expect(majorToMinor("12.34")).toBe(1234);
    expect(majorToMinor(0.29)).toBe(29);
    expect(minorToMajor(1234)).toBe(12.34);
  });
});
