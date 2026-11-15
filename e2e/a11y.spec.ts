import { expect, test, type Page } from "@playwright/test";
import { SITE } from "./helpers/site";
import { createTempTenant, enterDemo, hasLocalDb, rest } from "./helpers/tenant";

/**
 * Automated accessibility checks (axe-core, injected from node_modules) on the main public and dashboard pages,
 * plus keyboard behaviour of the chat widget and the structured data of a clinic page. Needs the local stack
 * for the clinic and dashboard pages (seeded demo businesses).
 */
const AXE = require.resolve("axe-core/axe.min.js");

type AxeResult = { id: string; impact: string | null; nodes: { target: string[]; html: string; failureSummary?: string }[] };

async function axeViolations(page: Page, rules: string[]): Promise<AxeResult[]> {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async (ids) => {
    // label-content-name-mismatch is an experimental rule (off by default): enable it explicitly.
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: AxeResult[] }> } }).axe;
    const config = { runOnly: { type: "rule", values: ids }, rules: { "label-content-name-mismatch": { enabled: true } } };
    return (await axe.run(document, config)).violations;
  }, rules);
}

const RULES = ["color-contrast", "label-content-name-mismatch", "button-name", "link-name", "label", "aria-allowed-attr", "aria-valid-attr-value", "aria-required-attr", "html-has-lang", "html-lang-valid", "image-alt"];

function describeViolations(v: AxeResult[]): string {
  return v.map((r) => `${r.id} (${r.impact}): ${r.nodes.slice(0, 4).map((n) => `${n.target.join(" ")} ${n.failureSummary?.split("\n")[1] ?? ""}`).join(" | ")}`).join("\n");
}

test.describe("axe: contrast, label-in-name, names and labels", () => {
  const publicPages = ["/ar/c/demo-clinic", "/en/c/demo-salon", "/en/login", "/ar/login", "/ar", "/en"];
  for (const path of publicPages) {
    test(`${path}`, async ({ page }) => {
      test.skip(path.includes("/c/") && !hasLocalDb(), "needs the local database");
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const v = await axeViolations(page, RULES);
      expect(v, describeViolations(v)).toEqual([]);
    });
  }

  for (const where of ["/dashboard", "/dashboard/calendar"]) {
    test(`dashboard ${where} (demo owner, en)`, async ({ page }) => {
      test.skip(!hasLocalDb(), "needs the local database");
      await enterDemo(page, "clinic-owner", "en");
      await page.goto(`/en${where}`);
      await page.waitForLoadState("networkidle");
      const v = await axeViolations(page, RULES);
      expect(v, describeViolations(v)).toEqual([]);
    });
  }

  // Mid-tone brand colours (white and ink both stay under 4.5:1 on them) get a darkened surface in brandStyleVars.
  for (const color of ["#808080", "#e91e63", "#00897b"]) {
    test(`a business with brand colour ${color}: axe finds no contrast problem`, async ({ page }) => {
      test.skip(!hasLocalDb(), "needs the local database");
      const biz = await createTempTenant({ label: "brand" });
      try {
        await rest(`tenants?id=eq.${biz.tenantId}`, { method: "PATCH", body: JSON.stringify({ brand_color: color }) });
        await page.goto(`/en/c/${biz.slug}`);
        await page.waitForLoadState("networkidle");
        const v = await axeViolations(page, ["color-contrast"]);
        expect(v, describeViolations(v)).toEqual([]);
      } finally {
        await biz.cleanup();
      }
    });
  }
});

test.describe("chat widget keyboard behaviour (phone overlay)", () => {
  test.use({ viewport: { width: 390, height: 800 }, hasTouch: true });
  const open = async (page: Page, path: string) => {
    await page.goto(path);
    await page.getByRole("button", { name: /assistant|المساعد/i }).first().click();
    return page.getByTestId("chat-widget");
  };
  const inPanel = (page: Page) => page.evaluate(() => !!document.activeElement?.closest("[data-testid=chat-widget]"));

  test("opening moves focus into the dialog; Escape closes it and focus returns to the launcher", async ({ page }) => {
    test.skip(!hasLocalDb(), "needs the local database");
    const widget = await open(page, "/en/c/demo-clinic");
    await expect(widget).toHaveAttribute("role", "dialog");
    await expect(widget).toHaveAttribute("aria-modal", "true");
    await expect(widget).toHaveAttribute("aria-labelledby", "chat-widget-title");
    await expect(page.locator("#chat-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open the assistant chat" })).toBeFocused();
    await expect(widget).toBeHidden();
  });

  test("Tab and Shift+Tab never leave the dialog", async ({ page }) => {
    test.skip(!hasLocalDb(), "needs the local database");
    await open(page, "/ar/c/demo-clinic");
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await inPanel(page), `Tab #${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await inPanel(page), `Shift+Tab #${i + 1}`).toBe(true);
    }
  });
});

test.describe("clinic page structured data", () => {
  test("BreadcrumbList is valid JSON-LD with absolute URLs and the localized names", async ({ page }) => {
    test.skip(!hasLocalDb(), "needs the local database");
    await page.goto("/en/c/demo-clinic");
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    const parsed = blocks.map((b) => JSON.parse(b) as { "@type"?: string; itemListElement?: { position: number; name: string; item: string }[] });
    const crumb = parsed.find((p) => p["@type"] === "BreadcrumbList");
    expect(crumb, "BreadcrumbList present").toBeTruthy();
    expect(crumb!.itemListElement!.map((i) => i.position)).toEqual([1, 2]);
    expect(crumb!.itemListElement![0].item).toBe(`${SITE}/en`);
    expect(crumb!.itemListElement![1].item).toBe(`${SITE}/en/c/demo-clinic`);
    expect(crumb!.itemListElement![1].name.length).toBeGreaterThan(0);
    for (const b of blocks) expect(b).not.toContain("</script"); // serialized safely
  });
});
