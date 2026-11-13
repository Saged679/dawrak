import { describe, expect, it } from "vitest";
import { isLockedInDemo } from "@/lib/dashboard/demo-lock";
import { authCookieOptions, withAuthMaxAge } from "@/lib/auth/cookie-options";

const demo = { tenant: { is_demo: true }, userId: "u1" };
describe("isLockedInDemo", () => {
  it("locks seeded rows (no creator) and other visitors' rows in a demo tenant", () => {
    expect(isLockedInDemo(demo, null)).toBe(true);
    expect(isLockedInDemo(demo, undefined)).toBe(true);
    expect(isLockedInDemo(demo, "someone-else")).toBe(true);
  });
  it("keeps the visitor's own rows editable, and never locks a real tenant", () => {
    expect(isLockedInDemo(demo, "u1")).toBe(false);
    expect(isLockedInDemo({ tenant: { is_demo: false }, userId: "u1" }, null)).toBe(false);
  });
});

describe("authCookieOptions (L1)", () => {
  it("is httpOnly, lax, 7 days by default, secure only in production", () => {
    expect(authCookieOptions({ production: true })).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", maxAge: 604800 });
    expect(authCookieOptions({ production: false }).secure).toBe(false);
    expect(authCookieOptions({ maxAge: 86400 }).maxAge).toBe(86400);
  });

  it("withAuthMaxAge replaces the library's forced 400 days but keeps removal cookies at 0", () => {
    expect(withAuthMaxAge({ maxAge: 34560000, httpOnly: true }, 86400)).toEqual({ maxAge: 86400, httpOnly: true });
    expect(withAuthMaxAge({ maxAge: 0 }, 86400).maxAge).toBe(0);
    expect(withAuthMaxAge<{ maxAge?: number }>({}).maxAge).toBe(604800);
  });
});
