/**
 * The server-built summary of the action awaiting the visitor's confirmation, taken from the tool OUTPUT of
 * the newest assistant message (never from the model's own words). The widget shows it verbatim as a card and
 * offers Confirm / Change only together with that card: without a `summary_text` there are no buttons.
 */
type PartLike = { type: string; state?: string; output?: unknown; text?: string };
type MessageLike = { role: string; parts: PartLike[] };

export function findPendingSummary(last: MessageLike | undefined, busy: boolean): string | null {
  if (busy || !last || last.role !== "assistant") return null;
  let found: string | null = null;
  for (const p of last.parts) {
    if (!p.type.startsWith("tool-prepare_") || p.state !== "output-available") continue;
    const out = p.output as { ok?: unknown; summary_text?: unknown } | null | undefined;
    found = out?.ok === true && typeof out.summary_text === "string" && out.summary_text.trim() !== "" ? out.summary_text : null;
  }
  return found;
}
