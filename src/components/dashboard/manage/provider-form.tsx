"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { saveProvider } from "@/app/[locale]/dashboard/providers/actions";
import { useRouter } from "@/i18n/navigation";
import type { ProviderFull } from "@/lib/dashboard/catalog";
import { Field, inputClass, Notice, primaryBtn, textareaClass, type Msg } from "./form-ui";

export function ProviderForm({ provider, canEdit }: { provider: ProviderFull | null; canEdit: boolean }) {
  const t = useTranslations("Providers");
  const tm = useTranslations("Manage");
  const te = useTranslations("Manage.errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [bad, setBad] = useState<string[]>([]);
  const [v, setV] = useState({
    name_ar: provider?.name_ar ?? "",
    name_en: provider?.name_en ?? "",
    title_ar: provider?.title_ar ?? "",
    title_en: provider?.title_en ?? "",
    bio_ar: provider?.bio_ar ?? "",
    bio_en: provider?.bio_en ?? "",
    is_active: provider?.is_active ?? true,
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setV((p) => ({ ...p, [k]: e.target.value }));
  const invalid = (k: string) => bad.includes(k);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setMsg(null);
    setBad([]);
    start(async () => {
      const res = await saveProvider({ id: provider?.id, ...v });
      if (res.ok) {
        if (!provider) {
          router.push(`/dashboard/providers/${res.id}`);
        } else {
          setMsg({ kind: "ok", text: tm("saved") });
          router.refresh();
        }
      } else {
        setBad(res.fields ?? []);
        setMsg({ kind: "error", text: te(res.code) });
      }
    });
  }

  return (
    <form method="post" onSubmit={submit} className="flex flex-col gap-6" noValidate data-testid="provider-form">
      <fieldset disabled={!canEdit || pending} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="sr-only">{provider ? t("editTitle") : t("newTitle")}</legend>
        <Field label={t("fields.nameAr")} error={invalid("name_ar")}>
          {(p) => <input {...p} name="name_ar" dir="rtl" lang="ar" required maxLength={100} value={v.name_ar} onChange={set("name_ar")} className={inputClass} />}
        </Field>
        <Field label={t("fields.nameEn")} error={invalid("name_en")}>
          {(p) => <input {...p} name="name_en" dir="ltr" lang="en" required maxLength={100} value={v.name_en} onChange={set("name_en")} className={inputClass} />}
        </Field>
        <Field label={t("fields.titleAr")} error={invalid("title_ar")}>
          {(p) => <input {...p} name="title_ar" dir="rtl" lang="ar" maxLength={100} value={v.title_ar} onChange={set("title_ar")} className={inputClass} />}
        </Field>
        <Field label={t("fields.titleEn")} error={invalid("title_en")}>
          {(p) => <input {...p} name="title_en" dir="ltr" lang="en" maxLength={100} value={v.title_en} onChange={set("title_en")} className={inputClass} />}
        </Field>
        <Field label={t("fields.bioAr")} error={invalid("bio_ar")}>
          {(p) => <textarea {...p} name="bio_ar" dir="rtl" lang="ar" maxLength={1000} value={v.bio_ar} onChange={set("bio_ar")} className={textareaClass} />}
        </Field>
        <Field label={t("fields.bioEn")} error={invalid("bio_en")}>
          {(p) => <textarea {...p} name="bio_en" dir="ltr" lang="en" maxLength={1000} value={v.bio_en} onChange={set("bio_en")} className={textareaClass} />}
        </Field>
        <label className="flex min-h-11 items-center gap-3 text-sm font-medium sm:col-span-2">
          <input
            type="checkbox"
            name="is_active"
            checked={v.is_active}
            onChange={(e) => setV((p) => ({ ...p, is_active: e.target.checked }))}
            className="size-5 accent-[var(--cobalt)]"
          />
          {t("fields.active")}
        </label>
      </fieldset>

      <Notice msg={msg} />
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={pending} className={primaryBtn} data-testid="provider-save">
            {pending ? tm("saving") : provider ? tm("save") : tm("create")}
          </button>
        </div>
      ) : null}
    </form>
  );
}
