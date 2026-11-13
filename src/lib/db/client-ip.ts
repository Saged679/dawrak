import "server-only";
import { createHash } from "node:crypto";

type HeaderReader = { get(name: string): string | null };

/**
 * Vercel overwrites x-forwarded-for / x-real-ip / x-vercel-forwarded-for with the client's
 * public IP (it does not append client-supplied values), so on Vercel they are trusted.
 * Anywhere else (local dev, self-host) any client can send them, so they are ignored.
 */
function onVercel(): boolean {
  return process.env.VERCEL === "1";
}

function plausible(v: string | undefined): string | null {
  const t = v?.trim();
  // Plausible IPv4/IPv6 characters only; rejects junk and oversize values.
  return t && t.length <= 45 && /^[0-9a-fA-F:.]+$/.test(t) ? t.toLowerCase() : null;
}

function firstValid(v: string | null): string | null {
  return plausible(v?.split(",")[0]);
}

/** Only a plain header token is accepted as TRUSTED_PROXY_HEADER (no spaces, no commas, bounded length). */
const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Optional, off Vercel only: the operator names the header their OWN reverse proxy sets (e.g. x-forwarded-for,
 * cf-connecting-ip). Rule: take the RIGHT-MOST entry. A proxy that appends (nginx, most load balancers) adds the
 * address it saw as the last entry, while everything to its left was supplied by the client and can be forged,
 * so the right-most entry is the only one the trusted proxy vouches for. A proxy that overwrites the header
 * (Cloudflare's cf-connecting-ip) sends a single value, for which right-most and only are the same. This is
 * correct for exactly ONE trusted proxy hop; with a CDN in front of a load balancer the right-most entry is the
 * balancer, not the visitor. Without TRUSTED_PROXY_HEADER every forwarded header is ignored.
 */
function configuredHeader(): string | null {
  const name = process.env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  return name && HEADER_NAME.test(name) ? name : null;
}

/** Raw client IP, or null when it cannot be trusted. Exported for tests only. */
export function resolveClientIp(
  headers: HeaderReader,
  trustProxy = onVercel(),
  trustedHeader: string | null = configuredHeader(),
): string | null {
  if (trustProxy) {
    return (
      firstValid(headers.get("x-vercel-forwarded-for")) ??
      firstValid(headers.get("x-real-ip")) ??
      firstValid(headers.get("x-forwarded-for"))
    );
  }
  if (trustedHeader) {
    const parts = headers.get(trustedHeader)?.split(",");
    return plausible(parts?.[parts.length - 1]);
  }
  return null;
}

let warned = false;
/** One warning per process: in production, off Vercel and without TRUSTED_PROXY_HEADER all clients share one bucket. */
function warnOnce(): void {
  if (warned || process.env.NODE_ENV !== "production" || onVercel() || configuredHeader()) return;
  warned = true;
  console.warn(
    "client_ip_unknown: not on Vercel and TRUSTED_PROXY_HEADER is not set, so every client shares ONE rate-limit bucket. Set TRUSTED_PROXY_HEADER to the header your reverse proxy sets (see .env.example).",
  );
}
/** Test hook. */
export function _resetClientIpWarning(): void {
  warned = false;
}

/**
 * Stable, non-reversible rate-limit key for the caller. The raw IP is never stored.
 * Without a trusted IP (dev, or missing headers) every caller shares one fixed bucket.
 */
export function getClientIp(headers: HeaderReader): string {
  warnOnce();
  const ip = resolveClientIp(headers) ?? "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}
