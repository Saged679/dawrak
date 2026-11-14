"use client";

import { useLayoutEffect, useRef, ViewTransition } from "react";

/** The first mount in a tab is the page load; every later mount is a client navigation. */
let hydrated = false;

/**
 * Route content wrapper used by template.tsx files. With the View Transitions API (React drives it for
 * router navigations) the old content fades out and the new content slides in from the inline-end side
 * (CSS in motion.css, mirrored through --dir). Without document.startViewTransition, the same entrance
 * plays as a plain CSS animation. Never on first load, so the LCP element is not delayed.
 */
export function PageEnter({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const isNavigation = hydrated;
    hydrated = true;
    if (!isNavigation) return;
    if (typeof document.startViewTransition === "function") return;
    ref.current?.classList.add("m-enter-fallback");
  }, []);

  return (
    <ViewTransition enter="m-page-in" exit="m-page-out" default="none">
      <div ref={ref} data-page-enter className={className}>
        {children}
      </div>
    </ViewTransition>
  );
}
