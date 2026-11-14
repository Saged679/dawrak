import type { ReactNode } from "react";

export const statusLinkClass =
  "inline-flex min-h-11 items-center rounded-lg px-4 py-2 font-medium text-cobalt underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
export const statusButtonClass =
  "inline-flex min-h-11 items-center rounded-lg bg-cobalt px-5 py-2 font-medium text-white hover:bg-cobalt-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Shared 404 / error layout (option 4: ink on mist, cobalt action, saffron rule). No error details ever. */
export function StatusView({ code, title, body, children }: { code: string; title: string; body: string; children: ReactNode }) {
  return (
    <main className="m-status mx-auto flex w-full max-w-2xl flex-1 flex-col items-start justify-center gap-4 px-6 py-16">
      <p className="font-heading text-sm font-semibold tracking-wide text-cobalt-deep" dir="ltr">
        {code}
      </p>
      <span className="h-1 w-12 rounded-full bg-saffron" aria-hidden="true" />
      <h1 className="font-heading text-3xl font-semibold text-ink">{title}</h1>
      <p className="max-w-[40em] text-lg text-muted-foreground">{body}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">{children}</div>
    </main>
  );
}
