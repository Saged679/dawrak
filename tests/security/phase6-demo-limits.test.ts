import { afterEach, describe, expect, it, vi } from "vitest";
import { demoCreateAllowed } from "@/lib/demo/limits";

afterEach(() => vi.unstubAllEnvs());

/** A counting limiter with real fixed-window semantics: every call counts, the call over `max` is refused. */
function limiter() {
  const counts = new Map<string, number>();
  const fn = async (key: string, max: number) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n <= max;
  };
  return { fn, counts };
}

describe("demoCreateAllowed (M-new1)", () => {
  it("checks the per-IP hour and day limits before the global budget", async () => {
    const l = limiter();
    const order: string[] = [];
    await demoCreateAllowed("ipA", async (k, m) => (order.push(k), l.fn(k, m)));
    expect(order).toEqual(["ip:ipA:demo:h", "ip:ipA:demo:d", "demo:create:global"]);
  });
  it("a blocked IP consumes NOTHING from the global budget, so it cannot lock everyone else out", async () => {
    vi.stubEnv("DEMO_CREATE_PER_MINUTE", "5");
    const l = limiter();
    let blocked = 0;
    for (let i = 0; i < 100; i++) if (!(await demoCreateAllowed("noisy", l.fn))) blocked++;
    expect(blocked).toBe(97); // 3 per hour pass, the other 97 are refused by the per-IP limit
    expect(l.counts.get("demo:create:global")).toBe(3); // only the 3 that passed counted globally
    // other visitors still get in
    expect(await demoCreateAllowed("other1", l.fn)).toBe(true);
    expect(await demoCreateAllowed("other2", l.fn)).toBe(true);
  });
  it("the global budget still caps many different IPs", async () => {
    vi.stubEnv("DEMO_CREATE_PER_MINUTE", "2");
    const l = limiter();
    expect(await demoCreateAllowed("a", l.fn)).toBe(true);
    expect(await demoCreateAllowed("b", l.fn)).toBe(true);
    expect(await demoCreateAllowed("c", l.fn)).toBe(false);
  });
});
