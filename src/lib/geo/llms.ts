/**
 * Builds /llms.txt and /llms-full.txt (llmstxt.org convention) from the same message files the
 * landing page renders, so the text cannot drift from the app. Pure: no Next, no env reads.
 */
type Messages = Record<string, unknown>;
export type GeoLocale = "en" | "ar";
type Msgs = Record<GeoLocale, Messages>;

/** Landing keys the llms files quote. The drift test fails if any of them disappears. */
export const FAQ_COUNT = 6;
export const DEMO_SLUGS = ["demo-clinic", "demo-salon"] as const;

export function pick(messages: Messages, path: string): unknown {
  let cur: unknown = messages;
  for (const part of path.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as object)) cur = (cur as Messages)[part];
    else throw new Error(`geo: missing message key "${path}"`);
  }
  return cur;
}

export function str(messages: Messages, path: string): string {
  const v = pick(messages, path);
  if (typeof v !== "string" || v.trim() === "") throw new Error(`geo: message "${path}" is not a string`);
  return v.trim();
}

function list(messages: Messages, path: string): string[] {
  const v = pick(messages, path);
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`geo: message "${path}" is not a string list`);
  }
  return v as string[];
}

export function normalizeSiteUrl(raw: string | undefined): string {
  const base = (raw || "http://localhost:3000").trim();
  try {
    return new URL(base).origin;
  } catch {
    return "http://localhost:3000";
  }
}

function faqBlock(m: Messages): string[] {
  const out: string[] = [];
  for (let i = 1; i <= FAQ_COUNT; i++) {
    out.push(`### ${str(m, `Landing.faq.q${i}`)}`, "", str(m, `Landing.faq.a${i}`), "");
  }
  return out;
}

function links(site: string): string[] {
  return [
    `- [Landing page, Arabic](${site}/ar): product overview in Arabic, the default language`,
    `- [Landing page, English](${site}/en): product overview in English`,
    `- [Demo, Arabic](${site}/ar/demo): free demo with fictional data, no sign-up`,
    `- [Demo, English](${site}/en/demo): free demo with fictional data, no sign-up`,
    `- [Sample clinic page, English](${site}/en/c/demo-clinic): public booking page of a fictional clinic`,
    `- [Sample salon page, English](${site}/en/c/demo-salon): public booking page of a fictional salon`,
    `- [Sample clinic page, Arabic](${site}/ar/c/demo-clinic): the same clinic in Arabic`,
    `- [Sample salon page, Arabic](${site}/ar/c/demo-salon): the same salon in Arabic`,
  ];
}

function tidy(lines: string[]): string {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildLlmsTxt(msgs: Msgs, siteUrl: string): string {
  const site = normalizeSiteUrl(siteUrl);
  const { en, ar } = msgs;
  return tidy([
    `# ${str(en, "Facts.name")} (${str(ar, "Facts.name")})`,
    "",
    `> ${str(en, "Facts.description")}`,
    "",
    str(en, "Facts.status"),
    "",
    `## ${str(en, "Facts.doesTitle")}`,
    "",
    ...list(en, "Facts.does").map((x) => `- ${x}`),
    "",
    `## ${str(en, "Facts.plannedTitle")}`,
    "",
    ...list(en, "Facts.planned").map((x) => `- ${x}`),
    "",
    "## Pages",
    "",
    ...links(site),
    "",
    "## Questions and answers",
    "",
    ...faqBlock(en),
    "## Optional",
    "",
    `- [Full facts](${site}/llms-full.txt): longer description, booking steps and the same text in Arabic`,
    "",
    "## بالعربية",
    "",
    `> ${str(ar, "Facts.description")}`,
    "",
    str(ar, "Facts.status"),
    "",
    `### ${str(ar, "Facts.plannedTitle")}`,
    "",
    ...list(ar, "Facts.planned").map((x) => `- ${x}`),
  ]);
}

export function buildLlmsFullTxt(msgs: Msgs, siteUrl: string): string {
  const site = normalizeSiteUrl(siteUrl);
  const lines: string[] = [];
  for (const loc of ["en", "ar"] as const) {
    const m = msgs[loc];
    const steps = [1, 2, 3, 4].map((i) => `${i}. ${str(m, `Landing.how.s${i}t`)}: ${str(m, `Landing.how.s${i}d`)}`);
    lines.push(
      `# ${str(m, "Facts.name")}`,
      "",
      `> ${str(m, "Facts.description")}`,
      "",
      str(m, "Facts.status"),
      "",
      `## ${str(m, "Facts.doesTitle")}`,
      "",
      ...list(m, "Facts.does").map((x) => `- ${x}`),
      "",
      `## ${str(m, "Landing.how.title")}`,
      "",
      str(m, "Landing.how.lead"),
      "",
      ...steps,
      "",
      `## ${str(m, "Landing.assistant.title")}`,
      "",
      str(m, "Landing.assistant.lead"),
      "",
      str(m, "Landing.assistant.chanD"),
      "",
      str(m, "Landing.assistant.handoffNote"),
      "",
      `## ${str(m, "Facts.plannedTitle")}`,
      "",
      ...list(m, "Facts.planned").map((x) => `- ${x}`),
      "",
      `## ${str(m, "Landing.faq.title")}`,
      "",
      ...faqBlock(m),
      `## ${str(m, "Landing.multi.title")}`,
      "",
      str(m, "Landing.multi.lead"),
      "",
      str(m, "Landing.multi.iso"),
      "",
      ...(loc === "en" ? ["## Pages", "", ...links(site), ""] : []),
    );
  }
  return tidy(lines);
}
