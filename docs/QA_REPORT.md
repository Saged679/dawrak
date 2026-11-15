# Dawrak QA regression report

Date: 2026-11-15. Scope: full regression across phases 1-9, local Supabase plus live checks of the deployed app. No secrets appear in this document.

## 1. Summary

| Area | Result |
|---|---|
| Lint, typecheck, production build | Clean (lint: 0 errors, 1 pre-existing unused-var warning in `e2e/webhook-moyasar.spec.ts`) |
| `npm audit` | 0 vulnerabilities |
| i18n | 923 keys, `ar` = `en` |
| pgTAP | 615 assertions pass, 12 files |
| Race tests | Pass: create-vs-create (30 rounds), create-vs-reschedule (20 rounds) |
| Vitest | 1198 tests pass, 71 files (1189 before the post-deploy fixes in section 12, +9 new) |
| Playwright | 3 consecutive green runs (see section 3) |
| Live Gemini QA | Initial 8 scenarios exposed 4 bugs; all fixed; re-run 8/8 pass |
| Security audit | No Critical or High initially; 1 High found and closed during review (see section 7) |
| Live quality (Lighthouse, axe, keyboard, browsers) | Pass after fixes |
| Post-deploy verification | Pass; 3 bugs found afterwards, fixed (section 12) |

## 2. Phase overview

| Phase | Subject | Outcome |
|---|---|---|
| 1 | Static checks: lint, typecheck, build, `npm audit` | Clean, 0 vulnerabilities |
| 2 | i18n parity | 923 keys, `ar` = `en` |
| 3 | Database: pgTAP and race tests | 615 pass (12 files); races pass |
| 4 | Unit and integration: Vitest | 1198 pass |
| 5 | End-to-end: Playwright | 3 consecutive green runs |
| 6 | Security audit (two Opus review rounds) | Findings fixed, migration 27 |
| 7 | Live quality: Lighthouse, axe, keyboard, WebKit/Firefox | Pass after fixes |
| 8 | Live AI QA with Gemini, key-pool failover | 8/8 after fixes |
| 9 | Post-deploy live verification | Pass; 3 follow-up bugs fixed |

## 3. Playwright (3 consecutive green runs)

| Project | Passed | Notes |
|---|---|---|
| chromium | 273 | Full suite, fake microphone for voice notes |
| mobile (Pixel 7) | 128 | Full suite; skips are desktop-only layout cases |
| firefox | 74 | Smoke subset by design (landing, SEO, booking invalid input, llms, demo visitors, status pages) |
| webkit | 22 | Static pages only (home, seo, llms). WebKit honours CSP `upgrade-insecure-requests` even for `http://localhost`, so the local production build cannot hydrate. A local limit, not a product bug |
| no-payments | 2 | Own project against a second server with no payment provider |

Skips are deliberate: project-level `testMatch` filters plus per-test conditional skips (viewport-specific cases, demo-only cases).

## 4. Live Gemini QA (phase 8)

| Item | Result |
|---|---|
| Initial run | 8 scenarios; found confirmation-flow bugs: invented confirmation token, false success message, reply in English to an Arabic user, missing `search_knowledge` call |
| After fixes | Re-run 8/8 pass |
| Volume | About 27 + 30 requests (initial run + re-run) |
| Latency | First byte 1.4-3.8 s; turns with tool calls 5-13 s |

Key-pool failover: 6 keys validated; rotation and failover covered by unit tests (`tests/agent/key-pool.test.ts`).

## 5. Race and database tests

| Test | Rounds | Result |
|---|---|---|
| Two simultaneous bookings for one slot (create-vs-create) | 30 | Exactly one wins each round |
| Booking vs reschedule on one slot (create-vs-reschedule) | 20 | No double booking |
| pgTAP | 12 files | 615 assertions pass (RLS isolation, booking functions, chat retention, confirmations, state version, grants) |

## 6. Live quality (phase 7)

| Check | Result |
|---|---|
| Lighthouse mobile performance | 94-99 |
| Lighthouse accessibility | 96-100 |
| Lighthouse best practices | 100 |
| Lighthouse SEO | 100, except noindex utility pages (63, expected) |
| axe | Only color contrast and label-in-name serious items; both fixed |
| Keyboard use of chat widget | Issues found and fixed |
| WebKit and Firefox live pass | Pass |

## 7. Security audit (phase 6)

No Critical or High found initially. Four Medium demo-mode issues (M1-M4) and six Low issues were fixed in migration 27. Two Opus review rounds followed and also found and closed:

| Finding | Severity | Summary |
|---|---|---|
| Purge deleting real tenants' chats | High | Demo cleanup could remove real clinics' conversations; scoped to demo data |
| M1-M3 (review round) | Medium | Demo isolation and session lifetime items (e.g. refreshed tokens must not extend a demo cookie beyond its short life) |
| M-new1 | Medium | Follow-up found in the second round |
| L1-L7 | Low | Hardening items |
| L-new1-3 | Low | Follow-ups, including inherited object keys (`__proto__`, `constructor`) in route lookup |

All closed; regression coverage lives in pgTAP, `tests/security/` and the e2e demo specs.

## 8. Post-deploy live verification (phase 9)

| Check | Result |
|---|---|
| Isolation between two visitors | Pass |
| Deposit-free demo clinic | Pass |
| Cookies (flags, lifetime) | Pass |
| Origin checks | Pass |
| Knowledge base isolation | Pass |

## 9. Bugs found and fixed

> Note: the IDs below are internal labels assigned while writing this report. The "Prevented by" column points to the relevant test area and was not verified test-by-test.

| ID | Severity | Bug | Status | Prevented by |
|---|---|---|---|---|
| AI-1 | High | Assistant invented a confirmation token | Fixed | `tests/agent/*` (confirmation tests), pgTAP confirmations, live re-run 8/8 |
| AI-2 | High | False success message without a booking | Fixed | Same |
| AI-3 | Medium | Reply in English to an Arabic user | Fixed | Agent tests, live re-run |
| AI-4 | Medium | `search_knowledge` not called when needed | Fixed | Agent tests, live re-run |
| SEC-H1 | High | Purge deleted real tenants' chats | Fixed (migration 27) | pgTAP `dawrak_chat_retention` |
| SEC-M1..M4, M-new1 | Medium | Demo issues | Fixed (migration 27) | pgTAP, `tests/security`, e2e demo |
| SEC-L1..L7, L-new1..3 | Low | Hardening | Fixed | Vitest (e.g. `auth-helpers.test.ts`), pgTAP |
| A11Y-1 | Serious (axe) | Color contrast | Fixed | `tests/a11y` |
| A11Y-2 | Serious (axe) | Label-in-name | Fixed | `tests/a11y` |
| A11Y-3 | Medium | Chat widget not keyboard operable | Fixed | Playwright keyboard spec |
| PD-1 | Medium | `/en/nope` could render the Arabic 404 (lang=ar, dir=rtl) | Fixed: rewrite now carries the path's locale | `tests/proxy/not-found.test.ts`; `e2e/status-pages.spec.ts` (no-JS, `/en/nope`, `/ar/nope`) |
| PD-2 | Medium | Unknown clinic slug returned Next's empty `__next_error__` shell (no lang, dir, h1) | Fixed: proxy checks the slug and rewrites to the rendered 404 (status 404 and noindex kept) | `tests/proxy/not-found.test.ts`; e2e no-JS `/ar/c/zzz-nope`, `/en/c/zzz-nope`, `/en/c/zzz-nope/my/abc` |
| PD-3 | Low | Disabled demo "New service" / "New provider" had a class attribute starting with function source text (client-module class helper called from a server component) | Fixed: class strings moved to non-client `form-classes.ts` | `tests/dashboard/no-client-values-in-server.test.ts` (static guard over all client modules); e2e assertion that no element class contains `function(` or `primaryBtn` |

## 10. Known limitations

| Limitation | Note |
|---|---|
| Real Moyasar and Resend not tested | Fake payment provider and mock mailbox only |
| No real iOS device | WebKit desktop engine only |
| IPv6 on Vercel unverified | |
| Chat conversation binding by design | When a phone number already belongs to a customer, a chat is bound to that customer |
| Shared catalogue | Demo and tenants share one catalogue design |
| Gemini free quota is per Google project | A key pool only helps with keys from different projects |
| No dark mode | By design |
| WebKit e2e is static-only locally | `upgrade-insecure-requests` against `http://localhost` |

## 11. Recommendations

| Item | Priority |
|---|---|
| Rotate leaked secrets | High |
| Register the site in Search Console | Medium |
| Optional: add a LICENSE | Low |

## 12. Post-deploy fixes: detail

- Locale on the 404 rewrite: `src/lib/auth/not-found-rewrite.ts` sets `x-next-intl-locale` on the rewritten request and response from the path's locale. Local `next start` rendered `/en/nope` in English before the change, so the production symptom was not reproduced locally; the fix makes the locale explicit rather than inferred and is unit-tested.
- Unknown clinic slug: `src/lib/db/tenant-exists.ts` calls the anon-granted `public_get_tenant` RPC from the proxy, caches positive hits for 60 s per instance, rejects malformed slugs without a request, and fails open (never 404s a real clinic during an outage). Verified with `next build` + `next start` on port 3100 and `curl`: `/en/c/zzz-nope` and `/ar/c/zzz-nope` return 404 with `<html lang dir>`, an `h1` and `noindex`. Cost: one cached RPC per clinic page request.
- Class helper: `inputClass`, `textareaClass`, `primaryBtn`, `quietBtn` now live in `src/components/dashboard/manage/form-classes.ts`. The same defect also affected `quietBtn` and `inputClass` used by the dashboard server pages. A static test now fails if any server module imports a lower-case value export from a `"use client"` module.
