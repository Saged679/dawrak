import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Two-phase confirmation protocol, token part.
 *
 * A `prepare_*` tool validates a booking action, changes nothing and returns a signed token. The matching
 * mutating tool accepts a call only with a token that verifies for THIS tenant, conversation, action and the
 * EXACT arguments, that has not expired, and that was issued in an earlier turn (the visitor-message count
 * must have grown). Single use and the "latest visitor message is an explicit yes" check live in tools.ts.
 *
 * Key: HKDF-SHA256 over CHAT_CONFIRM_SECRET when set, otherwise over SUPABASE_SERVICE_ROLE_KEY (a server
 * secret that already exists), with a fixed label. The key and tokens are never logged.
 */

export const CONFIRM_ACTIONS = ["create_booking", "reschedule_booking", "cancel_booking"] as const;
export type ConfirmAction = (typeof CONFIRM_ACTIONS)[number];

export const CONFIRM_TTL_MS = 15 * 60 * 1000;
const LABEL = "dawrak-chat-confirmation-v1";

export class ConfirmSecretMissing extends Error {
  constructor() {
    super("confirm_secret_missing");
  }
}

const MIN_SECRET_LENGTH = 32;
let warnedShortSecret = false;

/** CHAT_CONFIRM_SECRET is used only when it is at least 32 characters; a shorter one is ignored (derived fallback). */
function dedicatedSecret(env: Record<string, string | undefined>): string | undefined {
  const s = env.CHAT_CONFIRM_SECRET?.trim();
  if (!s) return undefined;
  // length AND not obviously low-entropy (a single repeated character, a handful of distinct characters)
  if (s.length >= MIN_SECRET_LENGTH && new Set(s).size >= 6) return s;
  if (env.NODE_ENV === "production" && !warnedShortSecret) {
    warnedShortSecret = true;
    console.warn("chat_confirm_secret_too_short: CHAT_CONFIRM_SECRET is ignored (needs 32+ characters with some variety)");
  }
  return undefined;
}

export function deriveConfirmKey(env: Record<string, string | undefined> = process.env): Buffer {
  const ikm = dedicatedSecret(env) || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!ikm) throw new ConfirmSecretMissing();
  return Buffer.from(hkdfSync("sha256", ikm, "dawrak", LABEL, 32));
}

export type TokenPayload = {
  v: 1;
  /** tenant, conversation, action, argument hash */
  t: string;
  c: string;
  a: ConfirmAction;
  h: string;
  /** issued at (ms), expiry (ms) */
  i: number;
  e: number;
  /** number of visitor messages in the conversation when issued */
  n: number;
  /** unique id (single-use key) */
  j: string;
};

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Stable hash of already-normalised arguments (keys sorted, undefined dropped). */
export function hashArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args)
    .filter((k) => args[k] !== undefined && args[k] !== null)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify(keys.map((k) => [k, args[k]])))
    .digest("hex");
}

export function signConfirmation(
  p: { tenantId: string; conversationId: string; action: ConfirmAction; argsHash: string; userMessageCount: number; now?: number },
  key: Buffer = deriveConfirmKey(),
): { token: string; jti: string; expiresAt: number } {
  const now = p.now ?? Date.now();
  const payload: TokenPayload = {
    v: 1,
    t: p.tenantId,
    c: p.conversationId,
    a: p.action,
    h: p.argsHash,
    i: now,
    e: now + CONFIRM_TTL_MS,
    n: p.userMessageCount,
    j: randomBytes(12).toString("base64url"),
  };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(createHmac("sha256", key).update(body).digest());
  return { token: `${body}.${sig}`, jti: payload.j, expiresAt: payload.e };
}

/** Signature check only: returns the payload when the token is authentic, otherwise null. */
export function readToken(token: unknown, key: Buffer = deriveConfirmKey()): TokenPayload | null {
  if (typeof token !== "string" || token.length > 1000) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  // strict base64url, no padding, no whitespace, no + or /; the signature is exactly 32 bytes (43 characters)
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig) || !/^[A-Za-z0-9_-]+$/.test(body)) return null;
  const expected = createHmac("sha256", key).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (p?.v !== 1 || typeof p.j !== "string" || typeof p.n !== "number") return null;
    return p;
  } catch {
    return null;
  }
}

export type TokenCheck =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: "missing" | "invalid" | "wrong_context" | "args_mismatch" | "expired" | "same_turn" | "stale" };

/** Everything about a token that does not need the database (single use is claimed afterwards). */
export function checkToken(
  token: unknown,
  want: { tenantId: string; conversationId: string; action: ConfirmAction; argsHash: string; userMessageCount: number; now?: number },
  key: Buffer = deriveConfirmKey(),
): TokenCheck {
  if (token === undefined || token === null || token === "") return { ok: false, reason: "missing" };
  const p = readToken(token, key);
  if (!p) return { ok: false, reason: "invalid" };
  if (p.t !== want.tenantId || p.c !== want.conversationId || p.a !== want.action) return { ok: false, reason: "wrong_context" };
  if (p.h !== want.argsHash) return { ok: false, reason: "args_mismatch" };
  if ((want.now ?? Date.now()) > p.e) return { ok: false, reason: "expired" };
  // A new visitor message must have arrived since the token was issued: prepare and execute can never share a turn.
  if (want.userMessageCount <= p.n) return { ok: false, reason: "same_turn" };
  // ... and it must be EXACTLY the next one: a confirmation that arrives after other turns is stale.
  if (want.userMessageCount !== p.n + 1) return { ok: false, reason: "stale" };
  return { ok: true, payload: p };
}
