/**
 * Dawrak logo geometry: a cobalt speech bubble (square tail corner at the inline-start bottom), a check-tick whose
 * curved bowl hints at the Arabic dal, and a saffron dot like an appointment slot. 64x64 viewBox, no text.
 * Pure data (no React, no next-intl) so the proxy's inline 404, icons and OG can import it cheaply.
 * src/components/brand/logo.tsx re-exports everything here.
 */
export const LOGO_VIEWBOX = 64;
export const LOGO_COLORS = {
  cobalt: "#2549D1",
  ink: "#101C3A",
  mist: "#EEF2F9",
  saffron: "#F2A93B",
  white: "#FFFFFF",
} as const;

/** Bubble with the square tail corner at bottom-left (LTR). */
export const LOGO_BUBBLE_LTR =
  "M24 6H40A20 20 0 0 1 60 26V38A20 20 0 0 1 40 58H4V26A20 20 0 0 1 24 6Z";
/** Same bubble mirrored: tail at bottom-right (RTL). */
export const LOGO_BUBBLE_RTL =
  "M40 6H24A20 20 0 0 0 4 26V38A20 20 0 0 0 24 58H60V26A20 20 0 0 0 40 6Z";
/** Appointment dot at the top inline-end corner. */
export const LOGO_DOT_LTR = { cx: 53, cy: 12, r: 8 } as const;
export const LOGO_DOT_RTL = { cx: 11, cy: 12, r: 8 } as const;
/** Tick stroke (round caps, width LOGO_TICK_WIDTH); same in both directions. */
export const LOGO_TICK_PATH = "M17 34C20 37 22 40 25 44C30 36 35 31 42 27";
export const LOGO_TICK_WIDTH = 6;
/** Transparent gap around the dot (added to its radius). */
export const LOGO_DOT_GAP = 3;
