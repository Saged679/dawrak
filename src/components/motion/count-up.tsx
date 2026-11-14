"use client";

import { useEffect, useRef } from "react";
import { countText, easeOutCubic, hasNumber } from "@/lib/motion/count";

const DURATION_MS = 900;

/**
 * Shows `text` (already formatted by the server: digits, grouping, currency) and counts up to it once, when
 * it first scrolls into view. The server markup is the final value. With reduced motion, no IntersectionObserver
 * or no digits it is left alone. The last frame writes the original text back, so the end value is exact.
 */
export function CountUp({ text, className, testId }: { text: string; className?: string; testId?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const show = () => el.setAttribute("data-count", "done");
    if (
      !hasNumber(text) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !("IntersectionObserver" in window)
    ) {
      show();
      return;
    }
    let raf = 0;
    let started = false;
    const run = () => {
      started = true;
      const t0 = performance.now();
      const frame = (now: number) => {
        const p = (now - t0) / DURATION_MS;
        el.textContent = countText(text, easeOutCubic(p));
        if (p < 1) raf = requestAnimationFrame(frame);
        else el.textContent = text;
      };
      el.textContent = countText(text, 0);
      show();
      raf = requestAnimationFrame(frame);
    };
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && !started) {
          io.disconnect();
          run();
        }
      },
      { threshold: 0.4 },
    );
    const r = el.getBoundingClientRect();
    if (r.top >= window.innerHeight) {
      // off screen: park at zero (nobody sees it), count when it arrives
      el.textContent = countText(text, 0);
      show();
    }
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      el.textContent = text;
    };
  }, [text]);

  return (
    <span
      ref={ref}
      data-count="pending"
      data-testid={testId}
      className={className}
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {text}
    </span>
  );
}
