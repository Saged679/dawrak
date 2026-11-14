import { cn } from "@/lib/utils";

/** Loading placeholder with a transform-only shimmer (static under reduced motion). Decorative: hidden from AT. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" data-skeleton className={cn("m-skeleton", className)} />;
}
