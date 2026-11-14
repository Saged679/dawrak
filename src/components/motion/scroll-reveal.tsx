"use client";

import { useEffect } from "react";
import { shouldArm, staggerDelay } from "@/lib/motion/reveal";

/** Single elements and groups (children are staggered) revealed once as they scroll into view. */
const SINGLE = [
  ".lp-sec .lp-head",
  ".lp-widget",
  ".lp-chan",
  ".lp-mail-card",
  ".lp-callout",
  ".lp-dash > .lp-card",
  ".lp-side > *",
  ".lp-faq",
  ".lp-cta-in > *",
  ".lp-langs > div:first-child",
  ".lp-mini",
].join(",");
const GROUPS = [".lp-steps", ".lp-feats", ".lp-trio", ".lp-pay", ".lp-sites", ".lp-dates"];

/**
 * Landing page motion driver. Renders nothing. Server HTML is fully visible (no-JS, pre-hydration, LCP):
 * after hydration, elements that start wholly below the fold are marked "pending" (the CSS that hides them
 * exists only under scripting:enabled + no-preference), then "in" once, when they scroll into view.
 * Also: header elevation on scroll and pausing the hero ambient glow while offscreen.
 */
export function ScrollReveal() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".lp");
    if (!root) return;
    const cleanups: Array<() => void> = [];

    const header = root.querySelector<HTMLElement>(".lp-topbar");
    if (header) {
      let raf = 0;
      const onScroll = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => header.toggleAttribute("data-elevated", window.scrollY > 8));
      };
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
      cleanups.push(() => {
        window.removeEventListener("scroll", onScroll);
        cancelAnimationFrame(raf);
      });
    }

    const hero = root.querySelector<HTMLElement>(".lp-hero");
    if (hero && "IntersectionObserver" in window) {
      const io = new IntersectionObserver(([e]) => {
        if (e.isIntersecting) hero.removeAttribute("data-ambient");
        else hero.setAttribute("data-ambient", "paused");
      });
      io.observe(hero);
      cleanups.push(() => io.disconnect());
    }

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced && "IntersectionObserver" in window) {
      const targets: Array<{ el: HTMLElement; delay: number }> = [];
      const seen = new Set<HTMLElement>();
      const add = (el: HTMLElement, delay: number) => {
        if (seen.has(el)) return;
        seen.add(el);
        targets.push({ el, delay });
      };
      for (const sel of GROUPS) {
        root.querySelectorAll<HTMLElement>(sel).forEach((group) => {
          Array.from(group.children).forEach((c, i) => add(c as HTMLElement, staggerDelay(i)));
        });
      }
      root.querySelectorAll<HTMLElement>(SINGLE).forEach((el) => add(el, 0));

      const vh = window.innerHeight;
      const timers: number[] = [];
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const el = entry.target as HTMLElement;
            const above = entry.boundingClientRect.bottom <= 0; // skipped by a fast scroll or anchor jump
            if (!entry.isIntersecting && !above) continue;
            io.unobserve(el);
            const delay = above ? 0 : Number(el.dataset.revealDelay ?? 0);
            el.style.setProperty("--m-delay", `${delay}ms`);
            el.setAttribute("data-reveal-state", "in");
            // after it has played, drop the delay so later hover/focus transitions are immediate
            timers.push(
              window.setTimeout(() => {
                el.setAttribute("data-reveal-state", "done");
                el.style.removeProperty("--m-delay");
              }, 700 + delay),
            );
          }
        },
        { rootMargin: "0px 0px -8% 0px" },
      );
      for (const { el, delay } of targets) {
        if (!shouldArm(el.getBoundingClientRect(), vh)) continue;
        el.dataset.revealDelay = String(delay);
        el.setAttribute("data-reveal-state", "pending");
        io.observe(el);
      }
      cleanups.push(() => {
        io.disconnect();
        timers.forEach(clearTimeout);
        root.querySelectorAll("[data-reveal-state]").forEach((el) => el.removeAttribute("data-reveal-state"));
      });
    }

    return () => cleanups.forEach((fn) => fn());
  }, []);

  return null;
}
