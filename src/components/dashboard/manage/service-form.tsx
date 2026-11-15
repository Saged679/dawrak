"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { saveService } from "@/app/[locale]/dashboard/services/actions";
import { useRouter } from "@/i18n/navigation";
import type { ServiceRow } from "@/lib/dashboard/catalog";
import { Field, Notice, type Msg } from "./form-ui";
import { inputClass, primaryBtn, textareaClass } from "./form-classes";

type ProviderOption = { id: string; name: string; is_active: boolean };

export function ServiceForm({
  service,
  providers,
  currency,
  canEdit,
}: {
  service: ServiceRow | null;
  providers: ProviderOption[];
  currency: string;
  canEdit: boolean;
}) {
  const t = useTranslations("Services");
  const tm = useTranslations("Manage");
  const te = useTranslations("Manage.errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [bad, setBad] = useState<string[]>([]);
  const [v, setV] = useState({
    name_ar: service?.name_ar ?? "",
    name_en: service?.name_en ?? "",
    description_ar: service?.description_ar ?? "",
    description_en: service?.description_en ?? "",
    duration_min: String(service?.duration_min ?? 30),
    buffer_min: String(service?.buffer_min ?? 0),
    price: String(service?.price ?? ""),
    is_active: service?.is_active ?? true,
  });
  const [linked, setLinked] = useState<string[]>(service?.providerIds ?? []);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setV((p) => ({ ...p, [k]: e.target.value }));
  const invalid = (k: string) => bad.includes(k);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setMsg(null);
    setBad([]);
    start(async () => {
      const res = await saveService({ id: service?.id, ...v, provider_ids: linked });
      if (res.ok) {
        if (!service) {
          router.push(`/dashboard/services/${res.id}`);
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
    <form method="post" onSubmit={submit} className="flex flex-col gap-6" noValidate data-testid="service-form">
      <fieldset disabled={!canEdit || pending} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="sr-only">{service ? t("editTitle") : t("newTitle")}</legend>
        <Field label={t("fields.nameAr")} error={invalid("name_ar")}>
          {(p) => <input {...p} name="name_ar" dir="rtl" lang="ar" required maxLength={100} value={v.name_ar} onChange={set("name_ar")} className={inputClass} />}
        </Field>
        <Field label={t("fields.nameEn")} error={invalid("name_en")}>
          {(p) => <input {...p} name="name_en" dir="ltr" lang="en" required maxLength={100} value={v.name_en} onChange={set("name_en")} className={inputClass} />}
        </Field>
        <Field label={t("fields.descriptionAr")} error={invalid("description_ar")}>
          {(p) => <textarea {...p} name="description_ar" dir="rtl" lang="ar" maxLength={500} value={v.description_ar} onChange={set("description_ar")} className={textareaClass} />}
        </Field>
        <Field label={t("fields.descriptionEn")} error={invalid("description_en")}>
          {(p) => <textarea {...p} name="description_en" dir="ltr" lang="en" maxLength={500} value={v.description_en} onChange={set("description_en")} className={textareaClass} />}
        </Field>
        <Field label={t("fields.duration")} hint={t("hints.duration")} error={invalid("duration_min")}>
          {(p) => <input {...p} name="duration_min" type="number" inputMode="numeric" min={5} max={720} step={5} required value={v.duration_min} onChange={set("duration_min")} className={inputClass} />}
        </Field>
        <Field label={t("fields.buffer")} hint={t("hints.buffer")} error={invalid("buffer_min")}>
          {(p) => <input {...p} name="buffer_min" type="number" inputMode="numeric" min={0} max={240} step={5} required value={v.buffer_min} onChange={set("buffer_min")} className={inputClass} />}
        </Field>
        <Field label={t("fields.price", { currency })} error={invalid("price")}>
          {(p) => <input {...p} name="price" type="number" inputMode="decimal" min={0} step="0.01" required dir="ltr" value={v.price} onChange={set("price")} className={inputClass} />}
        </Field>
        <div className="flex items-end">
          <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
            <input
              type="checkbox"
              name="is_active"
              checked={v.is_active}
              onChange={(e) => setV((p) => ({ ...p, is_active: e.target.checked }))}
              className="size-5 accent-[var(--cobalt)]"
            />
            {t("fields.active")}
          </label>
        </div>

        <fieldset className="min-w-0 sm:col-span-2" aria-invalid={invalid("provider_ids") || undefined}>
          <legend className="mb-2 text-sm font-medium text-ink">{t("fields.providers")}</legend>
          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noProviders")}</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {providers.map((p) => (
                <li key={p.id}>
                  <label className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-paper px-3 text-sm">
                    <input
                      type="checkbox"
                      name="provider"
                      value={p.id}
                      checked={linked.includes(p.id)}
                      onChange={(e) =>
                        setLinked((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)))
                      }
                      className="size-5 accent-[var(--cobalt)]"
                    />
                    <span className="min-w-0 truncate">{p.name}</span>
                    {!p.is_active ? <span className="text-xs text-muted-foreground">({t("inactive")})</span> : null}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      </fieldset>

      <Notice msg={msg} />
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={pending} className={primaryBtn} data-testid="service-save">
            {pending ? tm("saving") : service ? tm("save") : tm("create")}
          </button>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-line p-3 text-sm text-muted-foreground">{tm("readOnly")}</p>
      )}
    </form>
  );
}
