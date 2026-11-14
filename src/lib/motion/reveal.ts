/** Reveal-on-scroll decisions (pure). */
export const MAX_STAGGER = 6;
export const STAGGER_MS = 70;

/** Delay for the i-th child of a staggered group; capped so long lists never wait. */
export function staggerDelay(index: number): number {
  return Math.min(Math.max(0, index), MAX_STAGGER) * STAGGER_MS;
}

/**
 * Only elements wholly below the fold are armed. Anything that touches the viewport at load
 * (hero, first headings, LCP) is never hidden.
 */
export function shouldArm(rect: { top: number; bottom: number }, viewportHeight: number): boolean {
  return rect.top >= viewportHeight && rect.bottom > 0;
}
