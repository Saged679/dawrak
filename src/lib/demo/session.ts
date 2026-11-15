import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Per-visitor demo session. The cookie holds a random secret (httpOnly, not readable by page scripts);
 * the database only ever stores its SHA-256, so a row can be matched to a visitor but nobody who reads
 * the tables (or another visitor) can forge the cookie from it.
 */
export const DEMO_SESSION_COOKIE = "dawrak_demo_session";
const SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** Same lifetime as a demo visitor (6 h): the rows a session owns are purged after that. */
export const DEMO_SESSION_MAX_AGE = 60 * 60 * 6;

export const hashDemoSession = (raw: string) => createHash("sha256").update(raw).digest("hex");
export const isDemoSessionValue = (v: string | undefined | null): v is string => !!v && SHAPE.test(v);
export const newDemoSessionValue = () => randomBytes(32).toString("base64url");
const secureCookie = () => (process.env.NEXT_PUBLIC_SITE_URL ?? "").startsWith("https://");

/** Set-Cookie header value for a route handler that answers with a plain Response (the chat route). */
export function demoSessionSetCookie(raw: string): string {
  return `${DEMO_SESSION_COOKIE}=${raw}; Path=/; Max-Age=${DEMO_SESSION_MAX_AGE}; HttpOnly; SameSite=Lax${secureCookie() ? "; Secure" : ""}`;
}

/**
 * Chat owner cookie for REAL tenants. Deliberately a different cookie from the demo session: the demo session belongs
 * to the demo (6 h, rows purged by its hash), this one only binds a web conversation to its browser (30 days). The value
 * stored for a conversation is hash(raw, tenant), so the same browser has an unrelated owner value at every business and
 * nobody can link a visitor across clinics from the database.
 */
export const CHAT_SESSION_COOKIE = "dawrak_chat_session";
export const CHAT_SESSION_MAX_AGE = 60 * 60 * 24 * 30;

export const chatOwnerHash = (raw: string, tenantId: string) => createHmac("sha256", raw).update(`chat:${tenantId}`).digest("hex");

export function chatSessionSetCookie(raw: string): string {
  return `${CHAT_SESSION_COOKIE}=${raw}; Path=/; Max-Age=${CHAT_SESSION_MAX_AGE}; HttpOnly; SameSite=Lax${secureCookie() ? "; Secure" : ""}`;
}

export function readChatSessionFromHeader(cookieHeader: string | null): string | null {
  return readCookieValue(cookieHeader, CHAT_SESSION_COOKIE);
}

function readCookieValue(cookieHeader: string | null, name: string): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return isDemoSessionValue(v) ? v : null;
    }
  }
  return null;
}

/** The raw session value from a Cookie request header, or null (a malformed value counts as none). */
export function readDemoSessionFromHeader(cookieHeader: string | null): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === DEMO_SESSION_COOKIE) {
      const v = part.slice(i + 1).trim();
      return isDemoSessionValue(v) ? v : null;
    }
  }
  return null;
}

/** Mailbox hash of the current visitor, or null when they have no session. Safe in pages (read only). */
export async function readDemoSessionHash(): Promise<string | null> {
  const v = (await cookies()).get(DEMO_SESSION_COOKIE)?.value;
  return isDemoSessionValue(v) ? hashDemoSession(v) : null;
}

/**
 * Server actions only: ALWAYS issues a fresh session (new cookie, new hash). enterDemo calls it when it creates a
 * visitor, so the cookie's lifetime starts with the visitor's and a cookie from an earlier visit cannot carry over.
 */
export async function rotateDemoSessionHash(): Promise<string> {
  const jar = await cookies();
  const raw = newDemoSessionValue();
  jar.set(DEMO_SESSION_COOKIE, raw, { httpOnly: true, sameSite: "lax", secure: secureCookie(), path: "/", maxAge: DEMO_SESSION_MAX_AGE });
  return hashDemoSession(raw);
}

/** Server actions / route handlers only (sets a cookie when the visitor has none yet). */
export async function ensureDemoSessionHash(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(DEMO_SESSION_COOKIE)?.value;
  if (isDemoSessionValue(existing)) return hashDemoSession(existing);
  const raw = newDemoSessionValue();
  jar.set(DEMO_SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(),
    path: "/",
    maxAge: DEMO_SESSION_MAX_AGE,
  });
  return hashDemoSession(raw);
}
