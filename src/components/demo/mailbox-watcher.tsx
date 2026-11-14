"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const INTERVAL_MS = 2000;
const MAX_TRIES = 8;

type Props = {
  /** How many messages the server rendered. Polling stops (and the page refreshes) when more arrive. */
  initialCount: number;
  /** Poll at all? The server turns it on only for a visitor with a session and an empty mailbox. */
  active: boolean;
  labels: { waiting: string; none: string; found: string };
};

/**
 * The booking e-mail is queued after the response (after()), so it can land a second or two after the
 * visitor opens the mailbox. Polls a same-origin route every 2 s, at most 8 times, then stops. Without
 * JavaScript the page is still complete: the "Refresh" link next to it is the fallback. Nothing here
 * animates, so reduced-motion settings need no special case.
 */
export function MailboxWatcher({ initialCount, active, labels }: Props) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "waiting" | "none" | "found">(active ? "waiting" : "idle");
  const tries = useRef(0);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      tries.current += 1;
      try {
        const res = await fetch("/api/demo/mailbox", { cache: "no-store", credentials: "same-origin" });
        if (res.ok) {
          const data = (await res.json()) as { count?: number };
          if (!stopped && (data.count ?? 0) > initialCount) {
            setState("found");
            router.refresh();
            return;
          }
        }
      } catch {
        // offline blip: the next try (or the Refresh link) covers it
      }
      if (stopped) return;
      if (tries.current >= MAX_TRIES) {
        setState("none");
        return;
      }
      timer = setTimeout(tick, INTERVAL_MS);
    };
    timer = setTimeout(tick, INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, initialCount, router]);

  return (
    <p role="status" aria-live="polite" data-testid="mailbox-status" data-state={state} className="text-sm text-muted-foreground">
      {state === "waiting" ? labels.waiting : state === "none" ? labels.none : state === "found" ? labels.found : null}
    </p>
  );
}
