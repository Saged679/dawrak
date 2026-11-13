"use client";

import { useState, useTransition } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { reindex, removeDocument } from "@/app/[locale]/dashboard/knowledge/actions";
import { useRouter } from "@/i18n/navigation";
import { quietBtn } from "@/components/dashboard/manage/form-ui";

/** Retry / re-index and delete for one document row. Delete needs a second, explicit click. */
export function DocActions({ id, failed, locked = false }: { id: string; failed: boolean; locked?: boolean }) {
  const t = useTranslations("Knowledge");
  const te = useTranslations("Knowledge.errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; code?: string }>) => {
    setError(null);
    start(async () => {
      const res = await fn();
      if (res.ok) setConfirming(false);
      else setError(te((res.code ?? "generic") as "generic"));
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || locked}
          className={quietBtn}
          data-testid={`doc-reindex-${id}`}
          onClick={() => run(() => reindex({ id }))}
        >
          <RefreshCw className="size-4" aria-hidden />
          {failed ? t("retry") : t("reindex")}
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              disabled={pending}
              className={`${quietBtn} border-[#b3261e] text-[#7a1712] hover:bg-[#fde8e6]`}
              data-testid={`doc-delete-confirm-${id}`}
              onClick={() => run(() => removeDocument({ id }))}
            >
              {t("confirmDelete")}
            </button>
            <button type="button" className={quietBtn} onClick={() => setConfirming(false)}>
              {t("cancel")}
            </button>
          </>
        ) : (
          <button type="button" disabled={pending || locked} className={quietBtn} data-testid={`doc-delete-${id}`} onClick={() => setConfirming(true)}>
            <Trash2 className="size-4" aria-hidden />
            {t("delete")}
          </button>
        )}
      </div>
      {error ? (
        <p role="alert" className="max-w-64 text-xs text-[#7a1712]" data-testid="doc-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
