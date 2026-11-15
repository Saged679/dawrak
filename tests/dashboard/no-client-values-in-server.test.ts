import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

// A server component that imports a non-component value (a class string, a helper) from a "use client" module
// receives a client reference, whose text is "function(...)" and ends up in the HTML (class="function(..."). 
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) out.push(p);
  }
  return out;
}

describe("no value import from a client module into a server module", () => {
  const files = walk("src");
  const src = new Map(files.map((f) => [resolve(f), readFileSync(f, "utf8")]));
  const isClient = (s: string) => /^\s*(\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(s);
  const clientValueExports = new Map<string, string[]>();
  for (const [f, s] of src) {
    if (!isClient(s)) continue;
    const names = [...s.matchAll(/export\s+(?:const|let|function|async function)\s+([a-z]\w*)/g)].map((m) => m[1])
      .filter((n) => !/^use[A-Z]/.test(n) || true);
    const lower = names.filter((n) => /^[a-z]/.test(n));
    if (lower.length) clientValueExports.set(f, lower);
  }

  it("finds the client modules", () => expect(clientValueExports.size).toBeGreaterThan(0));

  it("server modules never import lower-case values from them", () => {
    const bad: string[] = [];
    for (const [f, s] of src) {
      if (isClient(s)) continue;
      for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
        const spec = m[2];
        let target: string | null = null;
        if (spec.startsWith("@/")) target = resolve("src", spec.slice(2));
        else if (spec.startsWith(".")) target = resolve(dirname(f), spec);
        if (!target) continue;
        const hit = [...clientValueExports.keys()].find((k) => k.replace(/\.(tsx?)$/, "") === target);
        if (!hit) continue;
        const wanted = m[1].split(",").map((x) => x.trim().replace(/^type\s+.*/, "").split(/\s+as\s+/)[0]).filter(Boolean);
        for (const w of wanted) if (clientValueExports.get(hit)!.includes(w)) bad.push(`${f} imports ${w} from ${hit}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
