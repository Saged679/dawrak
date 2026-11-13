import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Voice notes in the chat widget. Chromium runs with a fake microphone (see playwright.config.ts);
 * /api/chat is always mocked: no Gemini key exists and no audio ever leaves the test.
 */

const T = {
  en: {
    open: "Open the assistant chat",
    mic: "Record a voice note",
    stop: "Stop recording",
    cancel: "Cancel recording",
    discard: "Delete this recording",
    send: "Send voice note",
    play: "Play voice note",
    denied: "Microphone access was blocked",
    unsupported: "Voice notes are not available in this browser",
    rate: "You sent many voice notes",
    input: "Your message to the assistant",
  },
  ar: {
    open: "افتح المحادثة مع المساعد",
    mic: "سجّل رسالة صوتية",
    stop: "إيقاف التسجيل",
    cancel: "إلغاء التسجيل",
    discard: "حذف هذا التسجيل",
    send: "إرسال الرسالة الصوتية",
    play: "تشغيل الرسالة الصوتية",
    denied: "تم حظر الوصول إلى الميكروفون",
    unsupported: "الرسائل الصوتية غير متاحة في هذا المتصفح",
    rate: "أرسلت رسائل صوتية كثيرة",
    input: "رسالتك إلى المساعد",
  },
} as const;

function sse(chunks: object[]) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function mockChat(page: Page, bodies: unknown[] = []) {
  await page.route("**/api/chat", async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
        "x-conversation-id": "11111111-1111-4111-8111-111111111111",
      },
      body: sse([
        { type: "start" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Got your voice note." },
        { type: "text-end", id: "t1" },
        { type: "finish" },
      ]),
    });
  });
}

/** Records every stream the page opens so we can assert the microphone is released. */
async function trackStreams(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __streams: MediaStream[]; __violations: string[] };
    w.__streams = [];
    w.__violations = [];
    const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (gum) {
      navigator.mediaDevices.getUserMedia = async (c) => {
        const s = await gum(c);
        w.__streams.push(s);
        return s;
      };
    }
    document.addEventListener("securitypolicyviolation", (e) => {
      // zod probes eval support with new Function() inside try/catch at load: a harmless, pre-existing report
      if (e.blockedURI === "eval") return;
      w.__violations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
}

const liveTracks = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length,
  );

async function openChat(page: Page, locale: "en" | "ar", width = 1280) {
  await page.setViewportSize({ width, height: width < 500 ? 780 : 900 });
  await page.goto(`/${locale}/c/demo-clinic`, { waitUntil: "networkidle" });
  if (width < 500) await page.getByRole("button", { name: T[locale].open }).click();
  return page.getByTestId("chat-widget");
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "voice runs once; viewports are set explicitly");
});

test.describe("voice notes", () => {
  test("record, preview, cancel, record again, send; microphone is released each time", async ({ page }) => {
    const bodies: { message: { type: string; mediaType: string; data: string }; conversationId?: string }[] = [];
    await trackStreams(page);
    await mockChat(page, bodies);
    const chat = await openChat(page, "en");
    const mic = chat.getByRole("button", { name: T.en.mic });

    // The microphone is not requested until the tap.
    expect(await page.evaluate(() => (window as unknown as { __streams: unknown[] }).__streams.length)).toBe(0);

    await mic.click();
    await expect(chat.getByTestId("voice-timer")).toBeVisible();
    await expect(chat.getByTestId("voice-meter")).toBeVisible();
    await expect(chat.getByTestId("voice-live")).toContainText("Recording started");
    await expect.poll(() => chat.getByTestId("voice-timer").innerText(), { timeout: 5000 }).toMatch(/0:0[1-9]/);
    await chat.getByRole("button", { name: T.en.stop }).click();

    const draft = chat.getByTestId("voice-draft");
    await expect(draft).toBeVisible();
    await expect(chat.getByTestId("voice-live")).toContainText("Recording stopped");
    expect(await liveTracks(page)).toBe(0);
    await draft.getByRole("button", { name: T.en.play }).click(); // plays the local blob (media-src blob:)
    await expect(draft.getByRole("button", { name: "Pause voice note" })).toBeVisible();

    // Delete returns to the text form
    await chat.getByRole("button", { name: T.en.discard }).click();
    await expect(chat.getByTestId("voice-panel")).toHaveCount(0);
    await expect(chat.getByLabel(T.en.input)).toBeVisible();
    await expect(mic).toBeFocused();

    // Cancel while recording releases the mic immediately
    await mic.click();
    await expect(chat.getByTestId("voice-timer")).toBeVisible();
    await chat.getByRole("button", { name: T.en.cancel }).click();
    await expect(chat.getByTestId("voice-panel")).toHaveCount(0);
    expect(await liveTracks(page)).toBe(0);

    // Record again and send
    await mic.click();
    await expect.poll(() => chat.getByTestId("voice-timer").innerText(), { timeout: 5000 }).toMatch(/0:0[1-9]/);
    await chat.getByRole("button", { name: T.en.stop }).click();
    await chat.getByRole("button", { name: T.en.send }).click();

    await expect(chat.getByTestId("voice-bubble")).toBeVisible();
    await expect(chat.getByText("Got your voice note.")).toBeVisible();
    expect(bodies).toHaveLength(1);
    const m = bodies[0].message;
    expect(m.type).toBe("audio");
    expect(m.mediaType).toBe("audio/wav");
    const bytes = Buffer.from(m.data, "base64");
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString()).toBe("WAVE");
    expect(bytes.readUInt32LE(24)).toBe(16000); // 16 kHz
    expect(bytes.readUInt16LE(22)).toBe(1); // mono
    expect(bytes.readUInt16LE(34)).toBe(16); // 16-bit
    expect(m.data.length).toBeLessThan(1_200_000);
    expect(JSON.stringify(bodies[0])).not.toContain("blob:");

    // second message (text) reuses the conversation id; the voice bubble stays playable
    await chat.getByLabel(T.en.input).fill("thanks");
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => bodies[1]?.conversationId).toBe("11111111-1111-4111-8111-111111111111");
    await expect(chat.getByTestId("voice-bubble")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
  });

  test("hard stop at 25 s ends the recording by itself", async ({ page }) => {
    await trackStreams(page);
    await mockChat(page);
    await page.clock.install();
    const chat = await openChat(page, "en");
    await chat.getByRole("button", { name: T.en.mic }).click();
    await expect(chat.getByTestId("voice-timer")).toBeVisible();
    await page.waitForTimeout(1500); // real audio must exist; only the page timers are fake
    await page.clock.runFor(26_000);
    await expect(chat.getByTestId("voice-draft")).toBeVisible({ timeout: 10_000 });
    await expect(chat.getByTestId("voice-timer")).toHaveCount(0);
    expect(await liveTracks(page)).toBe(0);
  });

  test("keyboard: Enter on the mic starts, Escape cancels", async ({ page }) => {
    await trackStreams(page);
    await mockChat(page);
    const chat = await openChat(page, "en");
    await chat.getByRole("button", { name: T.en.mic }).focus();
    await page.keyboard.press("Enter");
    await expect(chat.getByTestId("voice-timer")).toBeVisible();
    await expect(chat.getByRole("button", { name: T.en.stop })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(chat.getByTestId("voice-panel")).toHaveCount(0);
    expect(await liveTracks(page)).toBe(0);
  });

  test("reduced motion: no animated meter", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockChat(page);
    const chat = await openChat(page, "en");
    await chat.getByRole("button", { name: T.en.mic }).click();
    await expect(chat.getByTestId("voice-timer")).toBeVisible();
    await expect(chat.getByTestId("voice-meter").locator("i")).toHaveCount(0);
  });

  for (const locale of ["en", "ar"] as const) {
    test(`${locale}: permission denied shows the text fallback`, async ({ page }) => {
      await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      });
      await mockChat(page);
      const chat = await openChat(page, locale);
      await chat.getByRole("button", { name: T[locale].mic }).click();
      await expect(chat.getByTestId("voice-error")).toContainText(T[locale].denied);
      // text still works
      await chat.getByLabel(T[locale].input).fill("hello");
      await expect(chat.getByRole("button", { name: locale === "en" ? "Send" : "إرسال", exact: true })).toBeEnabled();
    });

    test(`${locale}: unsupported browser (no MediaRecorder) shows a clear message`, async ({ page }) => {
      await page.addInitScript(() => {
        // @ts-expect-error simulate an old browser
        delete window.MediaRecorder;
      });
      const chat = await openChat(page, locale);
      await chat.getByRole("button", { name: T[locale].mic }).click();
      await expect(chat.getByTestId("voice-error")).toContainText(T[locale].unsupported);
    });
  }

  test("no device and a server-side audio rate limit map to messages", async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("none", "NotFoundError"));
    });
    const chat = await openChat(page, "en");
    await chat.getByRole("button", { name: T.en.mic }).click();
    await expect(chat.getByTestId("voice-error")).toContainText("No microphone was found");
  });

  test("audio_rate_limited from the API is shown with the typed-message hint", async ({ page }) => {
    await page.route("**/api/chat", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "audio_rate_limited", message: "x", retryAfterSeconds: 600 } }),
      }),
    );
    const chat = await openChat(page, "en");
    await chat.getByRole("button", { name: T.en.mic }).click();
    await expect.poll(() => chat.getByTestId("voice-timer").innerText(), { timeout: 5000 }).toMatch(/0:0[1-9]/);
    await chat.getByRole("button", { name: T.en.stop }).click();
    await chat.getByRole("button", { name: T.en.send }).click();
    await expect(page.getByTestId("chat-error")).toContainText(T.en.rate);
  });
});

test.describe("voice layout", () => {
  for (const locale of ["ar", "en"] as const) {
    for (const width of [360, 1280]) {
      test(`${locale} at ${width}px: recording and preview, RTL, no overflow, big tap targets`, async ({ page }, testInfo) => {
        await mockChat(page);
        const chat = await openChat(page, locale, width);
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        const mic = chat.getByRole("button", { name: T[locale].mic });
        expect((await mic.boundingBox())!.width).toBeGreaterThanOrEqual(44);
        await mic.click();
        await expect.poll(() => chat.getByTestId("voice-timer").innerText(), { timeout: 5000 }).toMatch(/0:0[1-9]/);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        for (const b of await chat.getByTestId("voice-panel").getByRole("button").all()) {
          const box = (await b.boundingBox())!;
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(44);
        }
        await testInfo.attach(`recording-${locale}-${width}`, { body: await page.screenshot(), contentType: "image/png" });
        await chat.getByRole("button", { name: T[locale].stop }).click();
        await expect(chat.getByTestId("voice-draft")).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await chat.getByRole("button", { name: T[locale].send }).click();
        await expect(chat.getByTestId("voice-bubble")).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        const bubble = (await chat.getByTestId("voice-bubble").boundingBox())!;
        const panel = (await chat.boundingBox())!;
        // sender bubbles sit on the reading-direction end side: right in LTR, left in RTL
        const mid = bubble.x + bubble.width / 2;
        if (locale === "en") expect(mid).toBeGreaterThan(panel.x + panel.width / 2);
        else expect(mid).toBeLessThan(panel.x + panel.width / 2);
        await testInfo.attach(`sent-${locale}-${width}`, { body: await page.screenshot(), contentType: "image/png" });
      });
    }
  }
});

/** Dashboard: a stored voice turn (placeholder + metadata only) shows a clear marker in both languages. */
test.describe("dashboard voice-note marker", () => {
  const readEnv = (name: string) => {
    if (process.env[name]) return process.env[name];
    try {
      return readFileSync(".env.local", "utf8").match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
    } catch {
      return undefined;
    }
  };
  const URL_ = readEnv("NEXT_PUBLIC_SUPABASE_URL");
  const KEY = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  const CLINIC = "d0000000-0000-4000-8000-000000000001";
  async function rest(path: string, init: RequestInit = {}) {
    const res = await fetch(`${URL_}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: KEY!, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation", ...init.headers },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }

  for (const locale of ["en", "ar"] as const) {
    test(`${locale}: list preview and thread show the voice marker`, async ({ page }) => {
      test.skip(!URL_ || !KEY, "needs the local Supabase stack");
      const [conv] = (await rest("conversations", { method: "POST", body: JSON.stringify({ tenant_id: CLINIC, channel: "web" }) })) as { id: string }[];
      try {
        await rest("messages", {
          method: "POST",
          body: JSON.stringify([
            { tenant_id: CLINIC, conversation_id: conv.id, role: "user", content: "[voice note, 12 s]", parts: { type: "audio", mediaType: "audio/wav", durationSeconds: 12 } },
            { tenant_id: CLINIC, conversation_id: conv.id, role: "user", content: "[voice note, 12 s]", parts: { type: "audio", mediaType: "audio/wav", durationSeconds: 12 } },
          ]),
        });
        await rest("rate_limits?key=like.*", { method: "DELETE" });
        await page.goto(`/${locale}/demo`);
        await page.getByTestId("demo-clinic-reception").click();
        await page.waitForURL(new RegExp(`/${locale}/dashboard`));
        const text = locale === "en" ? "Voice note, 12 s" : "رسالة صوتية، 12 ث";
        await page.goto(`/${locale}/dashboard/conversations`);
        await expect(page.getByTestId(`conv-${conv.id}`).getByTestId("voice-marker")).toContainText(text);
        await page.goto(`/${locale}/dashboard/conversations/${conv.id}`);
        await expect(page.getByTestId("voice-marker").first()).toContainText(text);
        await expect(page.getByTestId("thread-messages")).not.toContainText("[voice note");
      } finally {
        await rest(`messages?conversation_id=eq.${conv.id}`, { method: "DELETE" });
        await rest(`conversations?id=eq.${conv.id}`, { method: "DELETE" });
      }
    });
  }
});
