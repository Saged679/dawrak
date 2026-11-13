import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

function keys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    keys(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("dashboard messages", () => {
  for (const ns of [
    "Auth",
    "Demo",
    "Dash",
    "Overview",
    "Calendar",
    "Revenue",
    "Manage",
    "Services",
    "Providers",
    "Customers",
    "Settings",
    "Knowledge",
    "Conversations",
  ] as const) {
    it(`${ns} has identical keys in ar and en`, () => {
      expect(keys(ar[ns]).sort()).toEqual(keys(en[ns]).sort());
    });
  }
});
