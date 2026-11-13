"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

export const inputClass =
  "h-11 w-full rounded-lg border border-line bg-paper px-3 text-base text-ink outline-none focus-visible:border-cobalt focus-visible:ring-3 focus-visible:ring-ring/40 disabled:bg-mist disabled:text-muted-foreground aria-[invalid=true]:border-[#b3261e]";

export const textareaClass = cn(inputClass, "h-auto min-h-24 py-2 leading-relaxed");

export const primaryBtn =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-cobalt px-5 text-sm font-semibold text-white outline-none hover:bg-cobalt-deep focus-visible:ring-3 focus-visible:ring-ring/60 disabled:opacity-50";

export const quietBtn =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-line bg-paper px-4 text-sm font-medium text-ink outline-none hover:bg-sky focus-visible:ring-3 focus-visible:ring-ring/60 disabled:opacity-50";

/** Label + control + hint + error, wired with ids. `children` receives the props to spread on the control. */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  hint?: string;
  error?: boolean;
  className?: string;
  children: (props: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children({ id, "aria-describedby": hintId, "aria-invalid": error || undefined })}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type Msg = { kind: "ok" | "error" | "warn"; text: string } | null;

/** Status line: role=alert for problems (announced at once), role=status otherwise. */
export function Notice({ msg, testId }: { msg: Msg; testId?: string }) {
  if (!msg) return null;
  return (
    <p
      role={msg.kind === "error" ? "alert" : "status"}
      data-testid={testId ?? "form-msg"}
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        msg.kind === "ok" && "border-[#1d7a5f] bg-[#dff3ec] text-[#0f4d3b]",
        msg.kind === "warn" && "border-[#b8741a] bg-saffron-soft text-[#6b3f00]",
        msg.kind === "error" && "border-[#b3261e] bg-[#fde8e6] text-[#7a1712]",
      )}
    >
      {msg.text}
    </p>
  );
}
