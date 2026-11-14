"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * A thin saffron bar at the top while a client navigation to a different path is pending. Purely
 * visual (aria-hidden); hidden entirely under reduced motion by CSS.
 */
export function NavProgress() {
  const pathname = usePathname();
  const [from, setFrom] = useState<string | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      setFrom(window.location.pathname);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setFrom(null), 10_000);
    };
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      window.clearTimeout(timer);
    };
  }, []);

  // the bar lives while we are still on the path where the click happened
  const pending = from !== null && from === pathname;
  // the page content dims a little if the navigation takes longer than ~200 ms (CSS in motion.css)
  useEffect(() => {
    const root = document.documentElement;
    if (pending) root.setAttribute("data-nav-pending", "");
    else root.removeAttribute("data-nav-pending");
    return () => root.removeAttribute("data-nav-pending");
  }, [pending]);
  if (!pending) return null;
  return <div aria-hidden className="m-navbar" data-testid="nav-progress" />;
}
