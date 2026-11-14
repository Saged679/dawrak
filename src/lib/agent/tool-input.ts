import { InvalidToolInputError, type ToolCallRepairFunction, type ToolSet } from "ai";
import { z } from "zod";
import { isDateKey, zonedToUtc } from "@/lib/dashboard/time";

/**
 * Tolerance for what real models send, WITHOUT weakening what the tools accept:
 *  - null / "" / whitespace-only values mean "not provided" (they never become a value);
 *  - starts_at / new_starts_at: ISO-like text with or without seconds, with or without an offset; text with
 *    no offset is a wall-clock time in the TENANT timezone (same zonedToUtc as the dashboard);
 *  - date_from / date_to may come as a date-time: the date part is used;
 *  - user_confirmed: boolean true, or the strings "true" / "yes" (any case, trimmed). Nothing else counts
 *    (not 1, "y", "1", Arabic words, false, null) and a missing value NEVER defaults to true.
 * Everything is then validated by the original strict schema (z.strictObject: unknown keys, including any
 * tenant_id, are still rejected). Phone normalisation stays in the database.
 */

const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}/;

export function normalizeDateTime(value: unknown, timeZone: string): unknown {
  if (typeof value !== "string") return value;
  const m = DATETIME_RE.exec(value.trim());
  if (!m) return value;
  const [, date, hh, mm, ss = "00", frac, off] = m;
  const h = Number(hh);
  const min = Number(mm);
  const sec = Number(ss);
  if (!isDateKey(date) || h > 23 || min > 59 || sec > 59) return value;
  if (off) {
    const z = off.toUpperCase() === "Z" ? "Z" : `${off.slice(0, 3)}:${off.length > 3 ? off.slice(-2) : "00"}`;
    const oh = z === "Z" ? 0 : Number(z.slice(1, 3));
    const om = z === "Z" ? 0 : Number(z.slice(4, 6));
    if (oh > 23 || om > 59) return value;
    return `${date}T${hh}:${mm}:${ss}${frac ? `.${frac}` : ""}${z}`;
  }
  return new Date(zonedToUtc(date, h * 60 + min, timeZone).getTime() + sec * 1000).toISOString();
}

export function normalizeConfirmation(value: unknown): unknown {
  if (value === true) return true;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "true" || s === "yes") return true;
  }
  return value;
}

const DATETIME_KEYS = new Set(["starts_at", "new_starts_at"]);
const DATE_KEYS = new Set(["date_from", "date_to"]);

/** Cleans a raw model input object. Non-objects pass through unchanged (the strict schema rejects them). */
export function normalizeToolInput(raw: unknown, timeZone: string): unknown {
  // Some models send the arguments of an argument-less tool as null.
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    // An unknown key stays even when null/empty, so `tenant_id: null` is still rejected, never dropped.
    const known = KNOWN_KEYS.has(key);
    if (known && (v === null || v === undefined)) continue;
    if (known && typeof v === "string" && v.trim() === "") continue;
    if (key === "user_confirmed") out[key] = normalizeConfirmation(v);
    else if (DATETIME_KEYS.has(key)) out[key] = normalizeDateTime(v, timeZone);
    else if (DATE_KEYS.has(key) && typeof v === "string") out[key] = DATE_PREFIX_RE.exec(v.trim())?.[1] ?? v;
    else if (key === "phone" && typeof v === "number" && Number.isFinite(v)) out[key] = String(v);
    else out[key] = v;
  }
  return out;
}

/** Every field name any tool declares (see tools.ts). Anything else is an unknown key. */
const KNOWN_KEYS = new Set([
  "service_id",
  "provider_id",
  "date_from",
  "date_to",
  "starts_at",
  "new_starts_at",
  "appointment_id",
  "full_name",
  "phone",
  "email",
  "user_confirmed",
  "query",
]);

/** Wraps a strict object schema with the tolerant pre-processing. The JSON schema the model sees stays the strict one. */
export function tolerant<T extends z.ZodType>(strict: T, timeZone: string) {
  return z.preprocess((raw) => normalizeToolInput(raw, timeZone), strict);
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
  starts_at: "an ISO 8601 date-time such as 2030-01-01T09:30:00+03:00 (use a slot start returned by check_availability)",
  new_starts_at: "an ISO 8601 date-time such as 2030-01-01T09:30:00+03:00 (use a slot start returned by check_availability)",
  date_from: "a date as YYYY-MM-DD",
  date_to: "a date as YYYY-MM-DD",
  user_confirmed: "true, and only after the customer explicitly confirmed the summary",
  service_id: "the service id exactly as returned by list_services",
  provider_id: "the provider id exactly as returned by list_providers or check_availability",
  appointment_id: "an appointment id exactly as returned by get_my_appointments",
  full_name: "the customer's full name (2 to 100 characters)",
  phone: "the customer's phone number with country code (7 to 20 characters)",
  email: "a valid email address, or leave the field out when there is none (never null or empty text)",
};

/** A clear, value-free message the model can act on. */
export function describeIssues(toolName: string, issues: RawIssue[]): string {
  const lines: string[] = [];
  for (const i of issues) {
    if (i.code === "unrecognized_keys") {
      lines.push(`remove the unknown field(s): ${(i.keys ?? []).join(", ")}. This tool takes only its documented fields; never send tenant or business ids.`);
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
