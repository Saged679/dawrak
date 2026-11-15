"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import type { WriteResult } from "@/lib/dashboard/errors";
import { quietBtn } from "./form-classes";

/** Deactivate / reactivate button for a list row. The action is a server action chosen by the page. */
export function ActiveToggle({
  id,
  active,
  action,
  testId,
  disabled = false,
}: {
  id: string;
  active: boolean;
  action: (input: unknown) => Promise<WriteResult>;
  testId?: string;
  /** demo business: the database refuses changes to this seeded row */
  disabled?: boolean;
}) {
  const tm = useTranslations("Manage");
  const te = useTranslations("Manage.errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending || disabled}
        data-testid={testId}
        className={quietBtn}
        onClick={() => {
          setError(null);
          start(async () => {
            const res = await action({ id, active: !active });
            if (res.ok) router.refresh();
            else setError(te(res.code));
          });
        }}
      >
        {active ? tm("deactivate") : tm("activate")}
      </button>
      {error ? (
        <p role="alert" className="max-w-56 text-xs text-[#7a1712]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
