// Class strings shared by server and client components. Deliberately NOT a "use client" module: a server component that
// imports a value from a client module gets a client reference (a function), not the string.
import { cn } from "@/lib/utils";

export const inputClass =
  "h-11 w-full rounded-lg border border-line bg-paper px-3 text-base text-ink outline-none focus-visible:border-cobalt focus-visible:ring-3 focus-visible:ring-ring/40 disabled:bg-mist disabled:text-muted-foreground aria-[invalid=true]:border-[#b3261e]";

export const textareaClass = cn(inputClass, "h-auto min-h-24 py-2 leading-relaxed");

export const primaryBtn =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-cobalt px-5 text-sm font-semibold text-white outline-none hover:bg-cobalt-deep focus-visible:ring-3 focus-visible:ring-ring/60 disabled:opacity-50";

export const quietBtn =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-line bg-paper px-4 text-sm font-medium text-ink outline-none hover:bg-sky focus-visible:ring-3 focus-visible:ring-ring/60 disabled:opacity-50";
