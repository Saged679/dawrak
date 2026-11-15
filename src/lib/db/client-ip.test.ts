import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetClientIpWarning, bucketIp, getClientIp } from "./client-ip";

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
    const b = getClientIp(h({ "x-real-ip": "2001:db9::2" }));
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

describe("bucketIp (IPv6 /64)", () => {
  it("leaves IPv4 alone and unwraps IPv4-mapped IPv6", () => {
    expect(bucketIp("203.0.113.7")).toBe("203.0.113.7");
    expect(bucketIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });
  it("collapses every address of one /64 to the same bucket", () => {
    const a = bucketIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(bucketIp("2001:0DB8:0001:0002:1:2:3:4")).toBe(a);
    expect(bucketIp("2001:db8:1:2::1")).toBe(a);
    expect(bucketIp("2001:db8:1:3::1")).not.toBe(a);
  });
  it("expands :: correctly", () => {
    expect(bucketIp("::1")).toBe("0:0:0:0::/64");
    expect(bucketIp("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(bucketIp("fe80::1234:5678")).toBe("fe80:0:0:0::/64");
  });
  it("returns junk unchanged", () => {
    expect(bucketIp("1:2:3")).toBe("1:2:3");
    expect(bucketIp("1::2::3")).toBe("1::2::3");
  });
  it("getClientIp gives two addresses of one /64 the same key on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    const a = getClientIp(h({ "x-forwarded-for": "2001:db8:1:2::1" }));
    const b = getClientIp(h({ "x-forwarded-for": "2001:db8:1:2:ffff:ffff:ffff:ffff" }));
    const c = getClientIp(h({ "x-forwarded-for": "2001:db8:1:9::1" }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
