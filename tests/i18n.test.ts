import { describe, expect, it } from "vitest";
import { localeDir, routing } from "@/i18n/routing";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

describe("i18n config", () => {
  it("defaults to Arabic with RTL direction", () => {
    expect(routing.defaultLocale).toBe("ar");
    expect(localeDir.ar).toBe("rtl");
    expect(localeDir.en).toBe("ltr");
  });

  it("has the same message keys in both locales", () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(ar.Errors).sort()).toEqual(Object.keys(en.Errors).sort());
    expect("Home" in ar).toBe(false);
  });
});
