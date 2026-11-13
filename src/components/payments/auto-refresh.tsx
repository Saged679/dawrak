"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-reads the server state every few seconds (webhook confirmation lands asynchronously). */
export function AutoRefresh({ everyMs = 3000, maxTimes = 40 }: { everyMs?: number; maxTimes?: number }) {
  const router = useRouter();
  useEffect(() => {
    let n = 0;
    const id = window.setInterval(() => {
      n += 1;
      router.refresh();
      if (n >= maxTimes) window.clearInterval(id);
    }, everyMs);
    return () => window.clearInterval(id);
  }, [router, everyMs, maxTimes]);
  return null;
}
