export type DepositRule = { type: "fixed" | "percent" | null; value: number | null };

/**
 * Deposit in minor units (halalas) for a service price in major units (SAR).
 * - fixed: value is an amount in major units; percent: value is 0..100+ percent of the price.
 * - rounded to the nearest halala, never above the price, never negative, NaN/Infinity => 0.
 */
export function computeDepositMinor(priceMajor: number, rule: DepositRule): number {
  const priceMinor = Math.round(Number(priceMajor) * 100);
  if (!Number.isFinite(priceMinor) || priceMinor <= 0) return 0;
  const value = Number(rule.value);
  if (!Number.isFinite(value) || value <= 0 || !rule.type) return 0;
  const raw = rule.type === "percent" ? (priceMinor * value) / 100 : value * 100;
  const rounded = Math.round(raw);
  return Math.min(priceMinor, Math.max(0, rounded));
}

export function minorToMajor(minor: number): number {
  return Math.round(minor) / 100;
}

export function majorToMinor(major: number | string): number {
  return Math.round(Number(major) * 100);
}
