import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const state = vi.hoisted(() => ({ user: null as null | { app_metadata?: Record<string, unknown> } }));

vi.mock("next-intl/middleware", () => ({ default: () => () => NextResponse.next() }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_u: string, _k: string, o: { cookies: { setAll: (l: { name: string; value: string; options: object }[]) => void } }) => ({
    auth: {
      getUser: async () => {
        // a token refresh: the library writes its cookie with its own (very long) lifetime
        o.cookies.setAll([{ name: "sb-test-auth-token", value: "tok", options: { maxAge: 34560000, path: "/" } }]);
        return { data: { user: state.user } };
      },
    },
  }),
}));

import proxy from "@/proxy";
import { AUTH_COOKIE_MAX_AGE, DEMO_AUTH_COOKIE_MAX_AGE } from "@/lib/auth/cookie-options";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "k";
});

const maxAge = async () => {
  const res = await proxy(new NextRequest("http://localhost/en/dashboard"));
  return res.cookies.get("sb-test-auth-token")?.maxAge ?? res.headers.get("set-cookie");
};

describe("M1: the proxy keeps demo visitors' auth cookie short", () => {
  it("a refreshed demo visitor cookie lives 6 hours", async () => {
    state.user = { app_metadata: { demo_visitor: true } };
    expect(await maxAge()).toBe(DEMO_AUTH_COOKIE_MAX_AGE);
  });
  it("a normal user keeps the 7-day lifetime", async () => {
    state.user = { app_metadata: {} };
    expect(await maxAge()).toBe(AUTH_COOKIE_MAX_AGE);
  });
});
