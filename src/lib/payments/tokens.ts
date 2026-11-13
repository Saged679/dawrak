import { randomBytes } from "node:crypto";

/** 36 random bytes (288 bits) as url-safe base64: 48 chars. Not derived from any id. */
export function newPaymentToken(): string {
  return randomBytes(36).toString("base64url");
}

/** Cheap shape check so junk never reaches the database. */
export function isPaymentToken(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{40,128}$/.test(v);
}
