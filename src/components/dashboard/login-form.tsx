"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { signIn, type LoginState } from "@/lib/auth/actions";

const initial: LoginState = { error: null };

const fieldClass =
  "h-12 w-full rounded-lg border border-line bg-paper px-3 text-base text-ink outline-none focus-visible:border-cobalt focus-visible:ring-3 focus-visible:ring-ring/40";

export function LoginForm({ locale, next }: { locale: string; next: string }) {
  const t = useTranslations("Auth");
  const [state, action, pending] = useActionState(signIn, initial);

  return (
    <form method="post" action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("email")}
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          dir="ltr"
          className={`${fieldClass} text-start`}
          aria-invalid={state.error === "invalid" || state.error === "credentials" || undefined}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("password")}
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          dir="ltr"
          className={`${fieldClass} text-start`}
        />
      </label>
      {state.error ? (
        <p role="alert" className="m-rise rounded-lg bg-[#fde8e6] px-3 py-2 text-sm text-[#7a1712]">
          {t(`errors.${state.error}`)}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="h-12 rounded-full bg-cobalt px-6 font-heading font-semibold text-white outline-none hover:bg-cobalt-deep focus-visible:ring-3 focus-visible:ring-saffron disabled:opacity-60"
      >
        {pending ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
