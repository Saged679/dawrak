import { expect, test } from "@playwright/test";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

/** /llms.txt and /llms-full.txt as the HTTP endpoints serve them (the builders have unit tests). */
import { SITE } from "./helpers/site";

for (const path of ["/llms.txt", "/llms-full.txt"]) {
  test(`${path} is UTF-8 plain text, cacheable and has no private paths or secrets`, async ({ request }) => {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"].toLowerCase()).toContain("text/plain");
    expect(res.headers()["content-type"].toLowerCase()).toContain("utf-8");
    expect(res.headers()["cache-control"]).toContain("max-age");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(500);
    for (const bad of [/\/dashboard/, /\/api\//, /\/my\//, /\/pay\//, /\/login/, /service_role/i, /eyJ[A-Za-z0-9_-]{20,}/]) {
      expect(body).not.toMatch(bad);
    }
  });
}

test("llms.txt: llmstxt.org structure, absolute links on this site, English FAQ and the Arabic section", async ({ request }) => {
  const body = await (await request.get("/llms.txt")).text();
  expect(body.startsWith("# Dawrak")).toBe(true);
  expect(body).toMatch(/\n> .+/);
  for (const h of ["## What Dawrak does", "## Pages", "## Questions and answers", "## Optional", "## بالعربية"]) expect(body).toContain(h);
  const urls = [...body.matchAll(/\]\((.+?)\)/g)].map((m) => m[1]);
  expect(urls.length).toBeGreaterThan(5);
  for (const u of urls) expect(u.startsWith(`${SITE}/`), u).toBe(true);
  expect(body).toContain(`${SITE}/en/c/demo-clinic`);
  expect(body).toContain(`${SITE}/llms-full.txt`);
  expect(body).toContain(en.Landing.faq.q1);
  expect(body).toContain(ar.Facts.description);
  // planned features are labelled, never presented as shipped
  expect(body).toMatch(/Planned: connecting the assistant to WhatsApp/);
});

test("llms-full.txt: both languages, booking steps, FAQ and the multi-tenant note", async ({ request }) => {
  const body = await (await request.get("/llms-full.txt")).text();
  expect(body).toContain(en.Landing.how.title);
  expect(body).toContain(ar.Landing.how.title);
  expect(body).toContain(en.Landing.faq.a6);
  expect(body).toContain(ar.Landing.faq.a6);
  expect(body).toContain(en.Landing.multi.iso);
  expect(body).toContain(`${SITE}/ar/c/demo-salon`);
  const short = await (await request.get("/llms.txt")).text();
  expect(body.length).toBeGreaterThan(short.length);
});
