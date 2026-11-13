"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getClientIp } from "@/lib/db/client-ip";
import { rateLimitOk } from "@/lib/db/public";
import { providerForTenant } from "@/lib/payments";
import { isSafeCheckoutTarget } from "@/lib/payments/redirect";
import { fakePaymentId } from "@/lib/payments/fake";
import { processPaymentEvent } from "@/lib/payments/process";
import { derivePayState, loadPaymentView, saveCheckout, supabasePaymentStore } from "@/lib/payments/store";

const formSchema = z.object({
  token: z.string().min(40).max(128),
  slug: z.string().max(60).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  locale: z.enum(["ar", "en"]),
});

function parse(fd: FormData) {
  const p = formSchema.safeParse({
    token: fd.get("token"),
    slug: fd.get("slug"),
    locale: fd.get("locale"),
  });
  if (!p.success) notFound();
  return p.data;
}

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * "Pay deposit" button. Re-checks everything on the server (the token proves nothing about state),
 * creates the provider checkout once (reused on retry), then redirects to the hosted page.
 */
export async function startPayment(formData: FormData): Promise<void> {
  const { token, slug, locale } = parse(formData);
  const base = `/${locale}/c/${slug}/pay/${token}`;

  let target: string;
  try {
    const ip = getClientIp(await headers());
    if (!(await rateLimitOk(`ip:${ip}:pay`, 20, "10 minutes"))) {
      redirect(`${base}?error=rate`);
    }
    const view = await loadPaymentView(token, slug);
    if (!view) notFound();
    const state = derivePayState(view);
    if (state === "paid" || state === "expired" || state === "refund_due") {
      redirect(`${base}/result`);
    }
    const provider = providerForTenant(view.tenant);
    if (provider.name !== view.provider) throw new Error("provider_mismatch");

    let url = view.checkoutUrl;
    if (!url) {
      const expiresAt = new Date(view.appointment.paymentExpiresAt ?? Date.now() + 15 * 60_000);
      const checkout = await provider.createCheckout({
        paymentId: view.paymentId,
        amountMinor: view.amountMinor,
        currency: view.currency,
        description: `Deposit - ${view.tenant.name_en || view.tenant.name_ar}`.slice(0, 120),
        successUrl: `${siteUrl()}${base}/result`,
        backUrl: `${siteUrl()}${base}`,
        expiresAt,
      });
      await saveCheckout(view.paymentId, checkout.providerRef, checkout.checkoutUrl);
      // a concurrent click may have stored a different checkout first: always use the stored one
      const fresh = await loadPaymentView(token, slug);
      url = fresh?.checkoutUrl ?? checkout.checkoutUrl;
    }
    // never redirect to anything but the provider's hosted page (or our own fake page)
    if (!isSafeCheckoutTarget(url, provider.name, `${base}/fake`)) throw new Error("checkout_url_rejected");
    target = url;
  } catch (e) {
    if (isNextControl(e)) throw e;
    console.error("payment_start_error", e instanceof Error ? e.message : "unknown");
    redirect(`${base}?error=start`);
  }
  redirect(target);
}

function isNextControl(e: unknown): boolean {
  const d = (e as { digest?: unknown } | null)?.digest;
  return typeof d === "string" && (d.startsWith("NEXT_REDIRECT") || d.startsWith("NEXT_HTTP_ERROR_FALLBACK"));
}

/**
 * Fake provider only (demo / e2e): plays the role of "Moyasar redirects back and sends a webhook",
 * through the very same pipeline (fetchPayment -> settle_payment) the real webhook uses.
 */
export async function simulateFakePayment(formData: FormData): Promise<void> {
  const { token, slug, locale } = parse(formData);
  const outcome = formData.get("outcome") === "paid" ? "paid" : "failed";
  const view = await loadPaymentView(token, slug);
  // fake payments exist only for demo tenants, whatever the environment says
  if (!view || view.provider !== "fake" || !view.providerRef || !view.tenant.is_demo) notFound();
  let provider;
  try {
    provider = providerForTenant(view.tenant);
  } catch {
    notFound();
  }
  if (provider.name !== "fake") notFound();

  await processPaymentEvent(provider, supabasePaymentStore(), {
    eventId: `fake_evt_${randomUUID()}`,
    type: outcome === "paid" ? "payment_paid" : "payment_failed",
    providerPaymentId: fakePaymentId(outcome, view.amountMinor, view.currency, view.providerRef),
    checkoutRef: view.providerRef,
  });
  redirect(`/${locale}/c/${slug}/pay/${token}/result`);
}
