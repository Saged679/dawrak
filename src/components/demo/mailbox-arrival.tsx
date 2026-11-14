"use client";

import { useEffect } from "react";

const KEY = "dawrak-mailbox-seen";

/**
 * Flashes messages that were not in this tab's mailbox on the previous visit (the demo mail lands a second
 * or two after booking). The first ever visit never flashes. sessionStorage only; failures are ignored.
 */
export function MailboxArrival({ ids }: { ids: string[] }) {
  const key = ids.join(",");
  useEffect(() => {
    let seen: string[] | null = null;
    try {
      const raw = sessionStorage.getItem(KEY);
      seen = raw ? (JSON.parse(raw) as string[]) : null;
    } catch {
      seen = null;
    }
    const current = key ? key.split(",") : [];
    if (seen) {
      for (const id of current) {
        if (seen.includes(id)) continue;
        document.querySelector(`[data-mid="${CSS.escape(id)}"]`)?.classList.add("m-arrive");
      }
    }
    try {
      sessionStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      /* storage blocked */
    }
  }, [key]);
  return null;
}
