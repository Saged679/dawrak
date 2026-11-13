export type LinkPart = { text: string; href?: string };

/**
 * Splits plain text into text and link parts. Only URLs on `siteUrl`'s own origin become links; every
 * other URL (e.g. one a visitor typed into their name) stays inert text.
 */
export function linkPartsFor(body: string, siteUrl: string): LinkPart[] {
  let origin: string;
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    return [{ text: body }];
  }
  const parts: LinkPart[] = [];
  let last = 0;
  for (const m of body.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const start = m.index ?? 0;
    let same = false;
    try {
      same = new URL(m[0]).origin === origin;
    } catch {
      same = false;
    }
    if (!same) continue;
    if (start > last) parts.push({ text: body.slice(last, start) });
    parts.push({ text: m[0], href: m[0] });
    last = start + m[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last) });
  return parts.length ? parts : [{ text: body }];
}
