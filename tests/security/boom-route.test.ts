import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  },
}));

import Boom from "@/app/[locale]/boom/page";

describe("/[locale]/boom (L3)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("404s unless ALLOW_E2E_MOCKS is exactly 'true'", () => {
    for (const v of [undefined, "", "false", "TRUE", "1", " true"]) {
      if (v === undefined) vi.stubEnv("ALLOW_E2E_MOCKS", undefined as unknown as string);
      else vi.stubEnv("ALLOW_E2E_MOCKS", v);
      expect(() => Boom(), String(v)).toThrow("NOT_FOUND");
    }
  });

  it("throws the test error only with the flag", () => {
    vi.stubEnv("ALLOW_E2E_MOCKS", "true");
    expect(() => Boom()).toThrow("SECRET-INTERNAL-DETAIL");
  });
});
