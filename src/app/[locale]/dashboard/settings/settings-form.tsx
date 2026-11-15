"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Stethoscope, Scissors } from "lucide-react";
import { Field, inputClass, Notice, primaryBtn, type Msg } from "@/components/dashboard/manage/form-ui";
import { saveSettings } from "./actions";
import { useRouter } from "@/i18n/navigation";
import { BRAND_COLOR, CURRENCIES, readableOn, TIMEZONES } from "@/lib/dashboard/manage";

export type SettingsValues = {
  name_ar: string;
  name_en: string;
  timezone: string;
  currency: string;
  deposit_enabled: boolean;
  deposit_type: "fixed" | "percent";
  deposit_value: string;
  logo_url: string;
  brand_color: string;
};

export function SettingsForm({
  initial,
  kind,
  locale,
  demo = false,
}: {
  initial: SettingsValues;
  kind: "clinic" | "salon";
  locale: "ar" | "en";
  /** Demo business: identity, region and brand are locked (the database refuses them too). */
  demo?: boolean;
}) {
  const t = useTranslations("Settings");
  const tm = useTranslations("Manage");
  const te = useTranslations("Manage.errors");
  const tk = useTranslations("Dash.kind");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [bad, setBad] = useState<string[]>([]);
  const [v, setV] = useState(initial);
  const set = (k: keyof SettingsValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setV((p) => ({ ...p, [k]: e.target.value }));
  const locked = demo;
  const invalid = (k: string) => bad.includes(k);

  // A tenant already on a value outside the closed list keeps it selectable.
  const zones = [...new Set<string>([...TIMEZONES, initial.timezone])];
  const currencies = [...new Set<string>([...CURRENCIES, initial.currency])];

  const colorOk = v.brand_color === "" || BRAND_COLOR.test(v.brand_color);
  const { bg: previewBg, fg: previewFg } = readableOn(colorOk && v.brand_color !== "" ? v.brand_color : "#2549d1");
  const Icon = kind === "salon" ? Scissors : Stethoscope;
  const previewName = locale === "en" ? v.name_en || v.name_ar : v.name_ar || v.name_en;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBad([]);
    start(async () => {
      const res = await saveSettings(v);
      if (res.ok) {
        setMsg({ kind: "ok", text: tm("saved") });
        router.refresh();
      } else {
        setBad(res.fields ?? []);
        setMsg({ kind: "error", text: te(res.code) });
      }
    });
  }

  return (
    <form method="post" onSubmit={submit} noValidate className="flex flex-col gap-8" data-testid="settings-form">
      {demo ? (
        <p role="note" data-testid="settings-demo-locked" className="rounded-lg border border-line bg-mist px-4 py-3 text-sm">
          {t("demoLocked")}
        </p>
      ) : null}
      <fieldset disabled={pending} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-heading text-lg font-semibold">{t("sections.identity")}</legend>
        <Field label={t("fields.nameAr")} error={invalid("name_ar")}>
          {(p) => <input {...p} name="name_ar" disabled={locked} dir="rtl" lang="ar" required maxLength={100} value={v.name_ar} onChange={set("name_ar")} className={inputClass} />}
        </Field>
        <Field label={t("fields.nameEn")} error={invalid("name_en")}>
          {(p) => <input {...p} name="name_en" disabled={locked} dir="ltr" lang="en" required maxLength={100} value={v.name_en} onChange={set("name_en")} className={inputClass} />}
        </Field>
      </fieldset>

      <fieldset disabled={pending} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-heading text-lg font-semibold">{t("sections.region")}</legend>
        <Field label={t("fields.timezone")} hint={t("hints.timezone")} error={invalid("timezone")}>
          {(p) => (
            <select {...p} name="timezone" disabled={locked} dir="ltr" value={v.timezone} onChange={set("timezone")} className={inputClass}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t("fields.currency")} error={invalid("currency")}>
          {(p) => (
            <select {...p} name="currency" disabled={locked} dir="ltr" value={v.currency} onChange={set("currency")} className={inputClass}>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </Field>
      </fieldset>

      <fieldset disabled={pending} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-heading text-lg font-semibold">{t("sections.deposit")}</legend>
        <label className="flex min-h-11 items-center gap-3 text-sm font-medium sm:col-span-2">
          <input
            type="checkbox"
            name="deposit_enabled"
            checked={v.deposit_enabled}
            disabled={locked}
            onChange={(e) => setV((p) => ({ ...p, deposit_enabled: e.target.checked }))}
            className="size-5 accent-[var(--cobalt)]"
          />
          {t("fields.depositEnabled")}
        </label>
        <Field label={t("fields.depositType")} error={invalid("deposit_type")}>
          {(p) => (
            <select {...p} name="deposit_type" disabled={locked} value={v.deposit_type} onChange={set("deposit_type")} className={inputClass}>
              <option value="fixed">{t("depositTypes.fixed")}</option>
              <option value="percent">{t("depositTypes.percent")}</option>
            </select>
          )}
        </Field>
        <Field
          label={v.deposit_type === "percent" ? t("fields.depositPercent") : t("fields.depositAmount", { currency: v.currency })}
          hint={t("hints.deposit")}
          error={invalid("deposit_value")}
        >
          {(p) => <input {...p} name="deposit_value" disabled={locked} type="number" inputMode="decimal" min={0} max={v.deposit_type === "percent" ? 100 : undefined} step="0.01" dir="ltr" value={v.deposit_value} onChange={set("deposit_value")} className={inputClass} />}
        </Field>
      </fieldset>

      <fieldset disabled={pending} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-heading text-lg font-semibold">{t("sections.brand")}</legend>
        <Field label={t("fields.logoUrl")} hint={t("hints.logoUrl")} error={invalid("logo_url")}>
          {(p) => <input {...p} name="logo_url" disabled={locked} type="url" inputMode="url" dir="ltr" maxLength={500} placeholder="https://" value={v.logo_url} onChange={set("logo_url")} className={inputClass} />}
        </Field>
        <Field label={t("fields.brandColor")} hint={t("hints.brandColor")} error={invalid("brand_color") || !colorOk}>
          {(p) => (
            <div className="flex items-center gap-2">
              <input
                type="color"
                disabled={locked}
                aria-label={t("fields.brandColorPicker")}
                value={colorOk && v.brand_color !== "" ? v.brand_color : "#2549d1"}
                onChange={(e) => setV((s) => ({ ...s, brand_color: e.target.value }))}
                className="h-11 w-14 shrink-0 cursor-pointer rounded-lg border border-line bg-paper p-1"
              />
              <input {...p} name="brand_color" disabled={locked} dir="ltr" maxLength={7} placeholder="#2549d1" value={v.brand_color} onChange={set("brand_color")} className={inputClass} />
            </div>
          )}
        </Field>

        <div className="sm:col-span-2">
          <p className="mb-2 text-sm font-medium">{t("preview.title")}</p>
          <div
            data-testid="brand-preview"
            style={{ backgroundColor: previewBg, color: previewFg }}
            className="rounded-2xl px-4 py-5 sm:px-6"
          >
            <span
              className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium"
              style={{ backgroundColor: previewFg, color: previewBg }}
            >
              <Icon className="size-4" aria-hidden />
              {tk(kind)}
            </span>
            <p className="mt-3 font-heading text-2xl font-semibold" data-testid="brand-preview-name">
              {previewName}
            </p>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t("preview.caption")}</p>
        </div>
      </fieldset>

      <Notice msg={msg} />
      <div className="flex">
        <button type="submit" disabled={pending} className={primaryBtn} data-testid="settings-save">
          {pending ? tm("saving") : tm("save")}
        </button>
      </div>
    </form>
  );
}
