import type { MetadataRoute } from "next";
import { LOCALES } from "./site";

/** Paths crawlers must not fetch. Token pages additionally carry noindex headers/meta. */
export function disallowedPaths(): string[] {
  const out = ["/api/"];
  for (const l of LOCALES) {
    out.push(`/${l}/dashboard`, `/${l}/login`, `/${l}/demo/mailbox`);
  }
  out.push("/*/c/*/pay", "/*/c/*/my");
  return out;
}

/**
 * AI search / answer crawlers allowed on public pages. A named group replaces the "*" group for that
 * bot (it does not inherit), so each one repeats the same Disallow lines.
 */
export const AI_CRAWLERS = ["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot", "Google-Extended"] as const;

export function buildRobots(base: string): MetadataRoute.Robots {
  const disallow = disallowedPaths();
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow },
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: "/", disallow: [...disallow] })),
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
