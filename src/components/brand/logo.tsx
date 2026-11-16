import { useId } from "react";
import { useLocale } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  LOGO_BUBBLE_LTR,
  LOGO_BUBBLE_RTL,
  LOGO_COLORS,
  LOGO_DOT_GAP,
  LOGO_DOT_LTR,
  LOGO_DOT_RTL,
  LOGO_TICK_PATH,
  LOGO_TICK_WIDTH,
  LOGO_VIEWBOX,
} from "@/lib/brand/logo-geometry";

/**
 * Dawrak logo: a cobalt speech bubble (square tail corner at the inline-start
 * bottom), a check-tick whose curved bowl hints at the Arabic dal, and a saffron
 * dot like an appointment slot. 64x64 viewBox, pure geometry, no text.
 * The constants below are the single source of truth for icon.svg, apple-icon,
 * OG (Satori) and the inline 404 HTML. Mono tones knock the tick out of the
 * bubble with an SVG mask (browsers only; for Satori draw the tick in the
 * background colour instead).
 */
export * from "@/lib/brand/logo-geometry";

export type LogoTone = "color" | "mono-light" | "mono-dark";

const TONE: Record<LogoTone, { bubble: string; dot: string; tick: string | null }> = {
  color: { bubble: LOGO_COLORS.cobalt, dot: LOGO_COLORS.saffron, tick: LOGO_COLORS.white },
  "mono-light": { bubble: LOGO_COLORS.white, dot: LOGO_COLORS.white, tick: null },
  "mono-dark": { bubble: LOGO_COLORS.ink, dot: LOGO_COLORS.ink, tick: null },
};

type MarkProps = {
  size?: number;
  tone?: LogoTone;
  /** Force direction; default follows the document direction via CSS (Tailwind rtl: variant). */
  dir?: "ltr" | "rtl";
  title?: string;
  className?: string;
};

function tickPath(stroke: string) {
  return (
    <path
      d={LOGO_TICK_PATH}
      fill="none"
      stroke={stroke}
      strokeWidth={LOGO_TICK_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

export function LogoMark({ size = 32, tone = "color", dir, title, className }: MarkProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const t = TONE[tone];
  const knock = t.tick === null;
  const maskId = `dw-k-${uid}`;
  const show = (d: "ltr" | "rtl") =>
    dir ? (dir === d ? undefined : "hidden") : d === "ltr" ? "rtl:hidden" : "hidden rtl:inline";

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${LOGO_VIEWBOX} ${LOGO_VIEWBOX}`}
      width={size}
      height={size}
      className={className}
      data-tone={tone}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      <defs>
        {(["ltr", "rtl"] as const).map((d) => {
          const c = d === "ltr" ? LOGO_DOT_LTR : LOGO_DOT_RTL;
          return (
            <mask key={d} id={`${maskId}-${d}`} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
              <rect width="64" height="64" fill="#fff" />
              <circle cx={c.cx} cy={c.cy} r={c.r + LOGO_DOT_GAP} fill="#000" />
              {knock && tickPath("#000")}
            </mask>
          );
        })}
      </defs>
      {(["ltr", "rtl"] as const).map((d) => (
        <g key={d} className={show(d)} data-dir={d}>
          <path
            d={d === "ltr" ? LOGO_BUBBLE_LTR : LOGO_BUBBLE_RTL}
            fill={t.bubble}
            mask={`url(#${maskId}-${d})`}
          />
          <circle {...(d === "ltr" ? LOGO_DOT_LTR : LOGO_DOT_RTL)} fill={t.dot} />
        </g>
      ))}
      {!knock && tickPath(t.tick!)}
    </svg>
  );
}

type LogoProps = {
  size?: number;
  tone?: LogoTone;
  href?: string;
  showWordmark?: boolean;
  locale?: string;
  /** Accessible name when the wordmark is hidden (the link target may not be "home"). */
  label?: string;
  className?: string;
};

const WORDMARK = { ar: "دورك", en: "Dawrak" } as const;

export function Logo({
  size = 32,
  tone = "color",
  href = "/",
  showWordmark = true,
  locale,
  label,
  className,
}: LogoProps) {
  const current = useLocale();
  const isAr = (locale ?? current) === "ar";
  const word = isAr ? WORDMARK.ar : WORDMARK.en;
  const textColor = tone === "mono-light" ? LOGO_COLORS.white : LOGO_COLORS.ink;

  return (
    <Link
      href={href}
      // WCAG 2.5.3: with the wordmark visible the accessible name is that text.
      aria-label={showWordmark ? undefined : (label ?? `${word} — ${isAr ? "الصفحة الرئيسية" : "Home"}`)}
      className={`inline-flex items-center gap-[0.4em] no-underline ${className ?? ""}`}
      style={{ fontSize: size }}
    >
      <LogoMark size={size} tone={tone} />
      {showWordmark && (
        <span
          className="font-heading font-bold leading-none"
          style={{ color: textColor, fontSize: "0.72em", letterSpacing: isAr ? 0 : "-0.01em" }}
        >
          {word}
        </span>
      )}
    </Link>
  );
}
