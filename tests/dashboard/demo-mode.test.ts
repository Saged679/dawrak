import { describe, expect, it } from "vitest";
import { DEMO_PERSONAS, PERSONA_TARGET, demoEnabled } from "@/lib/auth/demo";

describe("demoEnabled (L3)", () => {
  it("is on only for DEMO_MODE exactly 'true'", () => {
    expect(demoEnabled({ DEMO_MODE: "true" })).toBe(true);
    for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
      expect(demoEnabled({ DEMO_MODE: v })).toBe(false);
    }
    expect(demoEnabled({})).toBe(false);
  });
});

describe("demo personas", () => {
  it("are clinic owner, clinic receptionist and salon owner, each mapped to a tenant and a role the DB accepts", () => {
    expect([...DEMO_PERSONAS]).toEqual(["clinic-owner", "clinic-reception", "salon-owner"]);
    for (const p of DEMO_PERSONAS) expect(["owner", "receptionist"]).toContain(PERSONA_TARGET[p].role);
    expect(PERSONA_TARGET["clinic-owner"].tenantId).not.toBe(PERSONA_TARGET["salon-owner"].tenantId);
  });
});
