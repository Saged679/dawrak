import { expect, test } from "@playwright/test";
import {
  ANON_KEY,
  CLINIC,
  DOCTOR,
  FIXED_DEMO_PASSWORD,
  FIXED_USERS,
  SERVICE_KEY,
  SUPABASE_URL,
  clearRateLimits,
  demoSessionHash,
  enterDemo,
  passwordGrant,
  rest,
  restShared,
  tokensForVisitor,
  visitorEmail,
} from "./helpers/tenant";

/**
 * Per-visitor demo (H1) and the read-mostly demo business (M3), against the LOCAL Supabase stack.
 * Every click on /demo creates a NEW temporary auth user; nothing is shared between visitors. Tests obtain a
 * visitor's own tokens server-side through the Admin API (never from the httpOnly cookie).
 */
test.describe("per-visitor demo users", () => {
  test.skip(!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY, "needs the local Supabase stack");
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "chromium", "runs once");
  });
  test.describe.configure({ mode: "serial" });

  test("two browsers entering as demo owner get two different users; re-entering the same persona keeps the user", async ({ browser }) => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    const pa = await a.newPage();
    const pb = await b.newPage();
    await enterDemo(pa, "clinic-owner");
    await enterDemo(pb, "clinic-owner");
    const ea = await visitorEmail(pa);
    const eb = await visitorEmail(pb);
    expect(ea).not.toBe(eb);

    // registered with the right tenant and role, expiring in about 6 h
    const rows = (await rest(`demo_users?select=user_id,tenant_id,role,expires_at`)) as { user_id: string; tenant_id: string; role: string; expires_at: string }[];
    const mine = rows.filter((r) => r.tenant_id === CLINIC && r.role === "owner");
    expect(mine.length).toBeGreaterThanOrEqual(2);
    const hours = (Math.max(...mine.map((r) => Date.parse(r.expires_at))) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(5);
    expect(hours).toBeLessThanOrEqual(6.1);

    // same persona again: the existing session is kept (same user, nothing new for this browser)
    await clearRateLimits();
    await pa.goto("/en/demo");
    await pa.getByTestId("demo-clinic-owner").click();
    await pa.waitForURL(/\/en\/dashboard/);
    expect(await visitorEmail(pa)).toBe(ea);

    // another persona gets a NEW user (and the old browser session is ended locally only)
    await clearRateLimits();
    await pa.goto("/en/demo");
    await pa.getByTestId("demo-clinic-reception").click();
    await pa.waitForURL(/\/en\/dashboard/);
    expect(await visitorEmail(pa)).not.toBe(ea);
    await expect(pa.getByRole("link", { name: "Revenue", exact: true })).toHaveCount(0); // receptionist
    // B, who shares nothing with A, is untouched
    await pb.goto("/en/dashboard");
    await expect(pb.getByTestId("tenant-name")).toBeVisible();
    await a.close();
    await b.close();
  });

  test("the provider persona is gone from /demo", async ({ page }) => {
    await page.goto("/en/demo");
    await expect(page.getByTestId("demo-clinic-owner")).toBeVisible();
    await expect(page.getByTestId("demo-clinic-reception")).toBeVisible();
    await expect(page.getByTestId("demo-salon-owner")).toBeVisible();
    await expect(page.getByTestId("demo-clinic-doctor")).toHaveCount(0);
  });

  test("A's global logout and password change with A's own tokens do not affect B", async ({ browser }) => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    const pa = await a.newPage();
    const pb = await b.newPage();
    await enterDemo(pa, "clinic-owner");
    await enterDemo(pb, "clinic-owner");
    const emailA = await visitorEmail(pa);
    const emailB = await visitorEmail(pb);
    const tokA = await tokensForVisitor(emailA);

    // A: global logout (the supabase-js default) and a password change, both with A's own access token
    const out = await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=global`, { method: "POST", headers: { apikey: ANON_KEY!, Authorization: `Bearer ${tokA.access}` } });
    expect(out.status).toBe(204);
    const tokA2 = await passwordGrant(emailA, tokA.password);
    const pw = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: { apikey: ANON_KEY!, Authorization: `Bearer ${tokA2.access}`, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "A-changed-Pw-1!" }),
    });
    expect(pw.ok).toBe(true); // allowed: it only affects A's own throw-away account

    // B is unaffected: its browser session still works, and a fresh dashboard load is authenticated
    await pb.goto("/en/dashboard/calendar");
    await expect(pb).toHaveURL(/\/en\/dashboard\/calendar/);
    await expect(pb.getByTestId("tenant-name")).toBeVisible();
    // and B can still sign in with... its own (unknown) password only: A's new password does not open B
    expect((await passwordGrant(emailB, "A-changed-Pw-1!")).access).toBeUndefined();
    // A's browser session died with the global logout, which is exactly A's own doing
    await pa.goto("/en/dashboard");
    await expect(pa).toHaveURL(/\/en\/login/);
    await a.close();
    await b.close();
  });

  test("the six fixed demo users cannot be changed through GoTrue even with their own session", async () => {
    const t = await passwordGrant(FIXED_USERS["clinic-owner"], FIXED_DEMO_PASSWORD);
    test.skip(!t.access, "fixed demo logins are not enabled on this database");
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: { apikey: ANON_KEY!, Authorization: `Bearer ${t.access}`, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "Hacked-Pw-1!" }),
    });
    expect(r.ok).toBe(false);
    expect((await passwordGrant(FIXED_USERS["clinic-owner"], FIXED_DEMO_PASSWORD)).access).toBeTruthy();
  });
});

test.describe("the demo business is read-mostly", () => {
  test.skip(!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY, "needs the local Supabase stack");
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "chromium", "runs once");
  });
  test.describe.configure({ mode: "serial" });

  test("a demo owner cannot rename a seeded provider: the DB refuses (42501 demo_readonly) and the UI shows it locked", async ({ page }) => {
    await enterDemo(page, "clinic-owner");
    const email = await visitorEmail(page);

    // the UI says so up front: banner, disabled fields, no save button
    await page.goto(`/en/dashboard/providers/${DOCTOR}`);
    await expect(page.getByTestId("demo-locked")).toContainText("Locked in the demo business");
    await expect(page.getByLabel("Name (English)")).toBeDisabled();
    await expect(page.getByTestId("provider-save")).toHaveCount(0);
    await expect(page.getByTestId("hours-save")).toHaveCount(0);
    // the whole catalogue is read-only in the demo (inserts are refused too): no time-off form
    await expect(page.getByTestId("time-off-add")).toHaveCount(0);

    // straight against PostgREST with the visitor's own JWT (taken last: setting a known password ends the browser session)
    const tok = await tokensForVisitor(email);
    const before = ((await rest(`providers?id=eq.${DOCTOR}&select=name_en`)) as { name_en: string }[])[0].name_en;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/providers?id=eq.${DOCTOR}`, {
      method: "PATCH",
      headers: { apikey: ANON_KEY!, Authorization: `Bearer ${tok.access}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ name_en: "Renamed by a visitor" }),
    });
    const body = (await res.json()) as { code?: string; message?: string };
    expect(res.status).toBe(403);
    expect(body.code).toBe("42501");
    expect(body.message).toContain("demo_readonly");
    expect(((await rest(`providers?id=eq.${DOCTOR}&select=name_en`)) as { name_en: string }[])[0].name_en).toBe(before);

  });

  test("seeded services: banner, disabled toggle, read-only edit page", async ({ page }) => {
    await enterDemo(page, "clinic-owner");
    const [svc] = (await rest(`services?tenant_id=eq.${CLINIC}&is_active=eq.true&select=id&limit=1`)) as { id: string }[];
    await page.goto("/en/dashboard/services");
    await expect(page.getByTestId("demo-locked")).toBeVisible();
    await expect(page.getByTestId(`service-${svc.id}`).getByRole("button", { name: "Deactivate" })).toBeDisabled();
    await expect(page.getByTestId("service-new")).toHaveAttribute("aria-disabled", "true"); // creating is refused by the database too
    // a client-module value called from a server component used to leak "function(...)" into class attributes
    await expect(page.getByTestId("service-new")).toHaveClass(/rounded-full/);
    expect(await page.locator('[class*="function("], [class*="primaryBtn"]').count()).toBe(0);
    await page.goto("/en/dashboard/providers");
    await expect(page.getByTestId("provider-new")).toHaveClass(/rounded-full/);
    expect(await page.locator('[class*="function("], [class*="primaryBtn"]').count()).toBe(0);
    await page.goto("/en/dashboard/services");
    await page.goto(`/en/dashboard/services/${svc.id}`);
    await expect(page.getByTestId("demo-locked")).toBeVisible();
    await expect(page.getByLabel("Name (English)")).toBeDisabled();
    await expect(page.getByTestId("service-save")).toHaveCount(0);
  });

  test("a demo owner can change the status of their OWN appointment, never a seeded one", async ({ page }) => {
    await enterDemo(page, "clinic-owner");
    const hash = await demoSessionHash(page);
    const [seeded] = (await rest(
      `appointments?tenant_id=eq.${CLINIC}&status=eq.confirmed&starts_at=gt.${new Date(Date.now() + 36e5).toISOString()}&order=starts_at.desc&limit=1`,
    )) as { id: string; starts_at: string; provider_id: string; service_id: string; customer_id: string }[];
    const start = new Date(new Date(seeded.starts_at).getTime() + 90 * 86_400_000 + Math.floor(Math.random() * 40) * 3_600_000);
    const own = await restShared<{ id: string; starts_at: string }>("appointments", {
      tenant_id: CLINIC, provider_id: seeded.provider_id, service_id: seeded.service_id, customer_id: seeded.customer_id,
      starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 1_800_000).toISOString(), status: "confirmed", source: "staff",
    }, hash);
    const day = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date(iso));
    try {
      await page.goto(`/en/dashboard/calendar?view=day&date=${day(own.starts_at)}`);
      await page.locator(`[data-id="${own.id}"]`).click();
      await page.getByTestId("set-no_show").click();
      await expect(page.getByTestId("dialog-msg")).toHaveText("Status updated.");
      await expect.poll(async () => ((await rest(`appointments?id=eq.${own.id}&select=status`)) as { status: string }[])[0].status).toBe("no_show");

      // the seeded one: disabled in the dialog, and refused by the database with the visitor's own token
      await page.goto(`/en/dashboard/calendar?view=day&date=${day(seeded.starts_at)}`);
      await page.locator(`[data-id="${seeded.id}"]`).click();
      await expect(page.getByTestId("set-no_show")).toBeDisabled();
      const tok = await tokensForVisitor(await visitorEmail(page));
      const res = await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${seeded.id}`, {
        method: "PATCH",
        headers: { apikey: ANON_KEY!, Authorization: `Bearer ${tok.access}`, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ status: "no_show" }),
      });
      expect(res.ok && (await res.text()) !== "[]", "seeded appointment must not change").toBe(false);
      expect(((await rest(`appointments?id=eq.${seeded.id}&select=status`)) as { status: string }[])[0].status).toBe("confirmed");
    } finally {
      await rest(`appointments?id=eq.${own.id}`, { method: "DELETE" });
    }
  });

  test("knowledge: seeded documents are locked, a visitor's own FAQ can be added and deleted", async ({ page }) => {
    const stamp = Date.now().toString(36);
    try {
      await enterDemo(page, "clinic-owner");
      await page.goto("/en/dashboard/knowledge");
      await expect(page.getByTestId("demo-locked")).toBeVisible();
      const seeded = (await rest(`kb_documents?tenant_id=eq.${CLINIC}&created_by=is.null&select=id&limit=1`)) as { id: string }[];
      if (seeded[0]) {
        await expect(page.getByTestId(`doc-delete-${seeded[0].id}`)).toBeDisabled();
        await expect(page.getByTestId(`doc-reindex-${seeded[0].id}`)).toBeDisabled();
      }
      await page.getByTestId("faq-question").fill(`E2E ${stamp} Is there a visitor entrance?`);
      await page.getByTestId("faq-answer").fill("Yes, the side door is open all day.");
      await page.getByTestId("faq-submit").click();
      await expect(page.getByTestId("faq-msg")).toContainText("Saved and indexed");
      const [mine] = (await rest(`kb_documents?tenant_id=eq.${CLINIC}&title=like.*E2E ${stamp}*&select=id`)) as { id: string }[];
      await expect(page.getByTestId(`doc-delete-${mine.id}`)).toBeEnabled();
      await page.getByTestId(`doc-delete-${mine.id}`).click();
      await page.getByTestId(`doc-delete-confirm-${mine.id}`).click();
      await expect(page.getByTestId(`kb-doc-${mine.id}`)).toHaveCount(0);
    } finally {
      await rest(`kb_documents?tenant_id=eq.${CLINIC}&title=like.*E2E ${stamp}*`, { method: "DELETE" });
    }
  });
});
