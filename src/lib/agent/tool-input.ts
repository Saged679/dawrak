import { InvalidToolInputError, type ToolCallRepairFunction, type ToolSet } from "ai";
import { z } from "zod";

/**
 * Tolerance for what real models send, WITHOUT weakening what the tools accept:
 *  - null / "" / whitespace-only values mean "not provided" (they never become a value);
 *  - `date` may come as a date-time (the date part is used); `date_from` is an alias of `date`;
 *  - `time` is HH:mm in the BUSINESS timezone; "17:30:00", "5:30 PM", "5.30pm" are read as 17:30. There is NO
 *    offset or timezone arithmetic here or in the model: the server converts date+time with zonedToUtc;
 *  - `user_confirmed` is DROPPED if a model still sends it (old prompts): it is never a confirmation, the
 *    server-side protocol (confirmation_token + the visitor's own latest message) is the only gate;
 *  - a numeric phone becomes text.
 * Everything is then validated by the original strict schema (z.strictObject: unknown keys, including any
 * tenant_id or a starts_at with an offset, are still rejected). Phone normalisation stays in the database.
 */

const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}.*)?$/;
const TIME_RE = /^(\d{1,2})(?:[:.h](\d{2}))?(?::\d{2}(?:\.\d+)?)?\s*(am|pm|a\.m\.|p\.m\.|ص|م)?$/i;

/** "17:30", "17:30:00", "5:30 PM", "9am" -> "HH:mm"; anything else is returned unchanged (and then rejected). */
export function normalizeTime(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const m = TIME_RE.exec(value.trim());
  if (!m) return value;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const ap = m[3]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return value;
    const pm = ap === "pm" || ap === "p.m." || ap === "م";
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || min > 59) return value;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Cleans a raw model input object. Non-objects pass through unchanged (the strict schema rejects them). */
export function normalizeToolInput(raw: unknown): unknown {
  // Some models send the arguments of an argument-less tool as null.
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [key0, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = key0 === "date_from" ? "date" : key0;
    if (key === "user_confirmed") continue; // accepted for old prompts, ignored: never a confirmation
    // An unknown key stays even when null/empty, so `tenant_id: null` is still rejected, never dropped.
    const known = KNOWN_KEYS.has(key);
    if (known && (v === null || v === undefined)) continue;
    if (known && typeof v === "string" && v.trim() === "") continue;
    if (key === "time") out[key] = normalizeTime(v);
    else if ((key === "date" || key === "date_to") && typeof v === "string") out[key] = DATE_PREFIX_RE.exec(v.trim())?.[1] ?? v;
    else if (key === "phone" && typeof v === "number" && Number.isFinite(v)) out[key] = String(v);
    else out[key] = v;
  }
  return out;
}

/** Every field name any tool declares (see tools.ts). Anything else is an unknown key. */
const KNOWN_KEYS = new Set([
  "service_id",
  "provider_id",
  "date",
  "date_to",
  "time",
  "appointment_id",
  "full_name",
  "phone",
  "email",
  "confirmation_token",
  "query",
]);

/** Wraps a strict object schema with the tolerant pre-processing. The JSON schema the model sees stays the strict one. */
export function tolerant<T extends z.ZodType>(strict: T, ignore: readonly string[] = []) {
  return z.preprocess((raw) => {
    const cleaned = normalizeToolInput(raw);
    if (ignore.length === 0 || typeof cleaned !== "object" || cleaned === null || Array.isArray(cleaned)) return cleaned;
    // fields an older prompt may still send are dropped (never used); every other unknown key, tenant_id included, stays and is rejected
    return Object.fromEntries(Object.entries(cleaned).filter(([k]) => !ignore.includes(k)));
  }, strict);
}

// ---------------------------------------------------------------------------------------------
// Validation feedback (no values, ever) and logging
// ---------------------------------------------------------------------------------------------

export type IssueSummary = { path: string; code: string };

type RawIssue = { path?: PropertyKey[]; code?: string; expected?: string; format?: string; keys?: string[] };

/** Finds the zod issues inside an AI SDK InvalidToolInputError (cause chain). */
export function extractIssues(error: unknown): RawIssue[] {
  let cur: unknown = error;
  for (let i = 0; i < 6 && cur; i++) {
    const issues = (cur as { issues?: unknown }).issues;
    if (Array.isArray(issues)) return issues as RawIssue[];
    cur = (cur as { cause?: unknown }).cause;
  }
  return [];
}

const pathOf = (i: RawIssue) => (i.path ?? []).map(String).join(".") || "(input)";

export function summarizeIssues(issues: RawIssue[]): IssueSummary[] {
  return issues.map((i) => ({ path: pathOf(i), code: String(i.code ?? "unknown") }));
}

const FIELD_HINTS: Record<string, string> = {
  date: "a date as YYYY-MM-DD in the business's local calendar",
  date_to: "a date as YYYY-MM-DD",
  time: "a time as HH:mm, 24-hour, in the business's local time (for example 17:30); never convert time zones",
  confirmation_token: "the confirmation_token returned by the matching prepare_ tool, unchanged",
  service_id: "the service id exactly as listed in the business catalog",
  provider_id: "the provider id exactly as listed in the business catalog or returned by check_availability",
  appointment_id: "an appointment id exactly as returned by get_my_appointments",
  full_name: "the customer's full name as the visitor wrote it (2 to 100 characters)",
  phone: "the customer's phone number as the visitor wrote it (7 to 20 characters)",
  email: "a valid email address the visitor wrote, or leave the field out when there is none (never null, empty or invented)",
};

/** A clear, value-free message the model can act on. */
export function describeIssues(toolName: string, issues: RawIssue[]): string {
  const lines: string[] = [];
  for (const i of issues) {
    if (i.code === "unrecognized_keys") {
      lines.push(`remove the unknown field(s): ${(i.keys ?? []).join(", ")}. This tool takes only its documented fields; never send tenant or business ids. Times are sent as date (YYYY-MM-DD) plus time (HH:mm) in the business's local time, never as starts_at or with an offset.`);
      continue;
    }
    const field = (i.path ?? []).map(String).join(".");
    const hint = FIELD_HINTS[field];
    const missing = i.code === "invalid_type" && /undefined/.test(String((i as { message?: string }).message ?? ""));
    lines.push(`${field || "input"}: ${missing ? "is required" : "is invalid"}${hint ? ` (expected ${hint})` : ""}`);
  }
  if (lines.length === 0) lines.push("the arguments do not match the tool's schema");
  return `Invalid arguments for ${toolName}, nothing was done. Fix these and call ${toolName} again in this same turn: ${lines.join("; ")}.`;
}

export type ToolInputLog = (entry: { tool: string; issues: IssueSummary[] }) => void;

export const defaultToolInputLog: ToolInputLog = (entry) => {
  console.warn("tool_input_invalid", JSON.stringify(entry));
};

/**
 * AI SDK repairToolCall: runs when a tool call fails input validation. It logs ONLY the tool name and the
 * issue paths/codes, then rejects the repair with a clear field-level message. The SDK turns that into a
 * tool error that goes back to the model in the same turn (it can fix the arguments and retry), instead of
 * the raw zod dump that also echoes the values the model sent.
 */
export function createRepairToolCall<TOOLS extends ToolSet>(opts: {
  log?: ToolInputLog;
  onInvalid?: (toolName: string) => void;
} = {}): ToolCallRepairFunction<TOOLS> {
  return async ({ toolCall, error }) => {
    if (!InvalidToolInputError.isInstance(error)) return null;
    const issues = extractIssues(error);
    (opts.log ?? defaultToolInputLog)({ tool: toolCall.toolName, issues: summarizeIssues(issues) });
    opts.onInvalid?.(toolCall.toolName);
    throw new Error(describeIssues(toolCall.toolName, issues));
  };
}
