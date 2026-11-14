/**
 * The chat shows plain text. Models sometimes answer in Markdown anyway ("*   **Bold** item"), which would
 * show up literally. This turns the common markers into plain text. It returns a STRING that React renders as
 * text (never HTML), so it cannot inject anything; it only removes or replaces characters.
 *
 *  - leading "*", "-", "+" or "•" list markers (followed by whitespace) become "• "
 *  - "**bold**", "__bold__", "*italic*", "_italic_", "`code`" lose their markers, the inner text stays
 *  - "# Heading" lines lose the leading # signs
 *  - runs of blank lines collapse to one blank line
 */
export function cleanAssistantText(input: string): string {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const out = lines.map((line) => {
    let l = line;
    // heading markers
    l = l.replace(/^\s{0,3}#{1,6}\s+/, "");
    // bullets (a marker needs trailing whitespace, so "-5 degrees" and "**bold**" are not bullets)
    l = l.replace(/^(\s*)[*+\-•]\s+/, "$1• ");
    // blockquote marker
    l = l.replace(/^\s{0,3}>\s?/, "");
    // bold / underline-bold: markers only (also an unfinished ** while streaming)
    l = l.replace(/\*\*/g, "").replace(/__/g, "");
    // italics with single markers hugging the text: *x* / _x_ (not "a * b", not snake_case)
    l = l.replace(/(^|[\s(])\*(\S(?:[^*\n]*?\S)?)\*(?=$|[\s).,!?:;،؟])/g, "$1$2");
    l = l.replace(/(^|[\s(])_(\S(?:[^_\n]*?\S)?)_(?=$|[\s).,!?:;،؟])/g, "$1$2");
    // inline code
    l = l.replace(/`([^`\n]*)`/g, "$1").replace(/`/g, "");
    return l.replace(/[ \t]+$/g, "");
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
