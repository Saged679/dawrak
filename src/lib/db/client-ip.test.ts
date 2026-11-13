import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetClientIpWarning, getClientIp } from "./client-ip";

const h = (o: Record<string, string>) => new Headers(o);
const UNKNOWN = getClientIp(h({}));

afterEach(() => vi.unstubAllEnvs());

describe("getClientIp", () => {
  it("ignores spoofable headers when not on Vercel", () => {
    vi.stubEnv("VERCEL", "");
    expect(getClientIp(h({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" }))).toBe(UNKNOWN);
  });

  it("falls back to a fixed key when headers are missing on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    expect(getClientIp(h({}))).toBe(UNKNOWN);
  });

  it("uses the trusted header on Vercel and hashes it", () => {
    vi.stubEnv("VERCEL", "1");
    const k = getClientIp(h({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "9.9.9.9" }));
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(k).not.toContain("203");
    expect(k).not.toBe(UNKNOWN);
    expect(k).toBe(getClientIp(h({ "x-real-ip": "203.0.113.9" })));
  });

  it("uses the first x-forwarded-for entry", () => {
    vi.stubEnv("VERCEL", "1");
    expect(getClientIp(h({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe(
      getClientIp(h({ "x-real-ip": "203.0.113.9" })),
    );
  });

  it("handles IPv6 and distinguishes addresses", () => {
    vi.stubEnv("VERCEL", "1");
    const a = getClientIp(h({ "x-real-ip": "2001:db8::1" }));
    const b = getClientIp(h({ "x-real-ip": "2001:db8::2" }));
    expect(a).not.toBe(UNKNOWN);
    expect(a).not.toBe(b);
    expect(a).toBe(getClientIp(h({ "x-real-ip": "2001:DB8::1" })));
  });

  it("rejects garbage header values", () => {
    vi.stubEnv("VERCEL", "1");
    expect(getClientIp(h({ "x-real-ip": "<script>" }))).toBe(UNKNOWN);
    expect(getClientIp(h({ "x-real-ip": "1".repeat(200) }))).toBe(UNKNOWN);
  });
});

describe("TRUSTED_PROXY_HEADER (off Vercel, L5)", () => {
  it("is ignored when not set: client-supplied forwarding headers cannot pick a bucket", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    const a = getClientIp(h({ "x-forwarded-for": "1.1.1.1", "cf-connecting-ip": "2.2.2.2" }));
    const b = getClientIp(h({ "x-forwarded-for": "3.3.3.3", "cf-connecting-ip": "4.4.4.4" }));
    expect(a).toBe(UNKNOWN);
    expect(b).toBe(UNKNOWN);
  });

  it("when set, only that header counts, and the RIGHT-MOST entry wins (forged left entries are ignored)", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "X-Forwarded-For");
    const real = getClientIp(h({ "x-forwarded-for": "198.51.100.7" }));
    expect(real).not.toBe(UNKNOWN);
    // an attacker prepends fake addresses; the trusted proxy appended the real one last
    expect(getClientIp(h({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 198.51.100.7" }))).toBe(real);
    // other headers stay ignored
    expect(getClientIp(h({ "x-real-ip": "198.51.100.7" }))).toBe(UNKNOWN);
    // junk in the trusted slot falls back to the shared bucket
    expect(getClientIp(h({ "x-forwarded-for": "1.2.3.4, <script>" }))).toBe(UNKNOWN);
  });

  it("a single-value header like cf-connecting-ip works the same way", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "cf-connecting-ip");
    expect(getClientIp(h({ "cf-connecting-ip": "203.0.113.50" }))).not.toBe(UNKNOWN);
    expect(getClientIp(h({ "x-forwarded-for": "203.0.113.50" }))).toBe(UNKNOWN);
  });

  it("refuses a malformed header name", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-forwarded-for, x-real-ip");
    expect(getClientIp(h({ "x-forwarded-for": "198.51.100.7" }))).toBe(UNKNOWN);
  });

  it("warns once in production when off Vercel and not configured; never when configured or on Vercel", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    _resetClientIpWarning();
    getClientIp(h({}));
    getClientIp(h({}));
    expect(warn).toHaveBeenCalledTimes(1);
    _resetClientIpWarning();
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-forwarded-for");
    getClientIp(h({}));
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    vi.stubEnv("VERCEL", "1");
    getClientIp(h({}));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
