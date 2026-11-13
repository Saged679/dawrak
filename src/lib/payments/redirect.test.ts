import { describe, expect, it } from "vitest";
import { isSafeCheckoutTarget } from "./redirect";

const FAKE = "/ar/c/clinic/pay/tok/fake";

describe("isSafeCheckoutTarget (moyasar)", () => {
  it.each([
    "https://moyasar.com/pay/abc",
    "https://api.moyasar.com/v1/invoices/x",
    "https://CHECKOUT.Moyasar.COM/i/1?x=1",
    "https://moyasar.com./pay/abc",
  ])("allows %s", (u) => expect(isSafeCheckoutTarget(u, "moyasar", FAKE)).toBe(true));

  it.each([
    "http://moyasar.com/pay/abc",
    "https://evilmoyasar.com/pay",
    "https://moyasar.com.evil.test/pay",
    "https://evil.test/moyasar.com",
    "https://evil.test/?u=https://moyasar.com",
    "https://moyasar.com@evil.test/pay",
    "https://user:pw@moyasar.com/pay",
    "https://user@moyasar.com/pay",
    "https://moyasar.com%2eevil.test/",
    "//moyasar.com/pay",
    "javascript:alert(1)",
    "data:text/html,x",
    "/ar/c/clinic/pay/tok/fake",
    "not a url",
    "",
  ])("rejects %s", (u) => expect(isSafeCheckoutTarget(u, "moyasar", FAKE)).toBe(false));
});

describe("isSafeCheckoutTarget (fake)", () => {
  it("allows only the exact internal fake path", () => {
    expect(isSafeCheckoutTarget(FAKE, "fake", FAKE)).toBe(true);
    for (const u of [
      `${FAKE}/`,
      `${FAKE}?x=1`,
      "/ar/c/clinic/pay/other/fake",
      `https://evil.test${FAKE}`,
      "https://moyasar.com/pay",
      "//evil.test/fake",
    ]) {
      expect(isSafeCheckoutTarget(u, "fake", FAKE)).toBe(false);
    }
  });
  it("rejects an unknown provider", () => {
    expect(isSafeCheckoutTarget("https://moyasar.com/x", "other", FAKE)).toBe(false);
  });
});
