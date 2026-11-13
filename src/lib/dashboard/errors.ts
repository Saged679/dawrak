export type StaffErrorCode =
  | "slot_taken"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "too_long"
  | "generic";

type DbError = { code?: string | null; message?: string | null } | null | undefined;

/** Maps a PostgREST / function error from the staff RPCs and updates to a message key. */
export function mapStaffError(error: DbError): StaffErrorCode {
  const msg = error?.message ?? "";
  const code = error?.code ?? "";
  if (code === "23P01" || msg.includes("slot_taken")) return "slot_taken";
  if (code === "42501" || msg.includes("forbidden") || msg.includes("permission denied")) {
    return "forbidden";
  }
  if (code === "23514") return "too_long";
  if (msg.includes("appointment_not_found")) return "not_found";
  if (
    msg.includes("invalid_status") ||
    msg.includes("provider_not_found") ||
    msg.includes("service_not_found")
  ) {
    return "invalid";
  }
  return "generic";
}

export type WriteErrorCode =
  | "forbidden"
  | "invalid"
  | "not_found"
  | "duplicate"
  | "too_long"
  | "demo_readonly"
  | "demo_limit"
  | "hours_invalid"
  | "hours_inverted"
  | "hours_overlap"
  | "timeoff_invalid"
  | "generic";

/**
 * Maps a PostgREST error from a catalogue / settings write to a message key. Order matters: the
 * demo trigger also uses SQLSTATE 42501, so it is matched by message before the generic
 * permission-denied case.
 */
export function mapWriteError(error: DbError): WriteErrorCode {
  const msg = error?.message ?? "";
  const code = error?.code ?? "";
  if (msg.includes("demo_readonly")) return "demo_readonly";
  if (code === "54000" || msg.includes("demo_limit")) return "demo_limit";
  if (
    code === "42501" ||
    msg.includes("forbidden") ||
    msg.includes("permission denied") ||
    msg.includes("row-level security")
  ) {
    return "forbidden";
  }
  if (code === "23505") return "duplicate";
  if (code === "23514") return "too_long";
  if (["23502", "23503", "22P02", "22003", "22007", "22008"].includes(code)) return "invalid";
  return "generic";
}

const LENGTH_CHECKED_TABLES = ["appointments", "customers", "providers", "services", "tenants", "time_off"];

/**
 * The column behind a CHECK violation, when the constraint name gives it away. The length checks
 * are named `<table>_<column>_len` (e.g. `services_name_ar_len`) and the message reads
 * `violates check constraint "services_name_ar_len"`. Returns null for any other constraint.
 */
export function checkViolationField(error: DbError): string | null {
  const name = /check constraint "([a-z0-9_]+)"/i.exec(error?.message ?? "")?.[1];
  if (!name || !name.endsWith("_len")) return null;
  const body = name.slice(0, -"_len".length);
  const table = LENGTH_CHECKED_TABLES.find((t) => body.startsWith(`${t}_`));
  return table ? body.slice(table.length + 1) || null : null;
}

export type WriteResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; code: WriteErrorCode; fields?: string[]; weekday?: number };

/** A failed WriteResult for a database error, naming the offending input for `too_long` checks. */
export function writeFailure(error: DbError): Extract<WriteResult, { ok: false }> {
  const code = mapWriteError(error);
  const field = code === "too_long" ? checkViolationField(error) : null;
  return field ? { ok: false, code, fields: [field] } : { ok: false, code };
}
