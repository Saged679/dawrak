# Dawrak user stories and e2e coverage

Each story has acceptance criteria and the Playwright spec(s) in `e2e/` that prove it. Unit and database tests (`tests/`, `supabase/tests/`) back the same rules but are not listed here. "Both locales / phone" means the story runs in Arabic (RTL) and English, and in the `mobile` project (Pixel 7) or at 360 px.

Projects: `chromium` (all specs), `mobile` (all specs; mutating specs skip themselves), `no-payments` (second server without a payment provider), `firefox` and `webkit` (smoke subset only: home, landing, seo, llms, booking-invalid, demo-visitors, status-pages).

## Visitor / patient

| ID | Story | Acceptance criteria | Spec |
|---|---|---|---|
| V1 | I land on the site and understand the product | One h1, landmarks, final state visible with no JS or reduced motion, CTA links work, locale switch keeps the path, no horizontal overflow at 360 and 1280 | `landing.spec.ts`, `home.spec.ts`, `status-pages.spec.ts`, `motion.spec.ts` |
| V2 | Search engines and AI crawlers find correct info | Title, canonical, hreflang, OG, JSON-LD match visible FAQ; robots and sitemap; `/llms.txt` and `/llms-full.txt` are UTF-8 text, absolute links, no private paths | `seo.spec.ts`, `llms.spec.ts` |
| V3 | I book a clinic or salon from the web form | Slot picked, details entered, row in DB; deposit clinics go to an unguessable pay URL, salons are confirmed straight away | `booking.spec.ts`, `reminders.spec.ts` |
| V4 | Bad input is refused clearly | Bad phone, bad e-mail, 1-char name refused inline in ar and en; past, outside-hours, >90-day and malformed start times rejected by the server, nothing created; taken slot shows the friendly message with "pick another time" | `booking.spec.ts`, `booking-invalid.spec.ts` |
| V5 | I pay the deposit | Fake checkout success confirms; failure keeps pending and allows retry; hold expires and frees the slot; forged URLs and query strings change nothing; unavailable provider gives an honest message and creates nothing | `payments.spec.ts`, `payments-unavailable.spec.ts` |
| V6 | I manage my booking from the emailed link | View on `/my/[token]`; cancel while more than 2 h ahead; inside 2 h there are no controls and a forced cancel gets the too-late error (ar text uses the `{hours}` placeholder); reschedule moves the appointment; cancelled rows are read only; bad tokens are a bare 404; privacy headers | `my-token.spec.ts`, `reminders.spec.ts` |
| V7 | I get reminders and can recover my link | 24 h and 2 h reminders scheduled, sent by cron, rescheduled with the appointment; request-a-link gives the same neutral answer for known and unknown contacts | `reminders.spec.ts` |
| V8 | I try the demo with no sign-up | One click creates a private visitor; own mailbox only; mail appears live; seeded data is read-mostly | `demo-visitors.spec.ts`, `demo-mailbox-live.spec.ts`, `chat-booking-mail.spec.ts` |
| V9 | The site works in Arabic and English, on a phone | `dir` and `lang` correct, no overflow, 404 and error pages localized | `landing.spec.ts`, `booking.spec.ts` (layout), `status-pages.spec.ts`, `reminders.spec.ts`, `payments.spec.ts` |

## Chat assistant (offline mock model)

| ID | Story | Acceptance criteria | Spec |
|---|---|---|---|
| C1 | I can book by chat | Summary card with Confirm / Change; booking only after Confirm; premature `create_booking` blocked | `chat-confirmation.spec.ts`, `chat-booking-mail.spec.ts` |
| C2 | The chat stays usable when limits hit | Daily quota, per-minute limit and not-configured states are worded and offer the form; Markdown shown as plain text | `chat-quota.spec.ts`, `booking.spec.ts` (widget) |
| C3 | I can send a voice note | Record, preview, cancel, send; hard stop at 25 s; denied or unsupported mic shows the typed fallback; API limits mapped | `voice.spec.ts` |
| C4 | The assistant cannot book without a payment provider | Honest `payments_unavailable`, no booking | `payments-unavailable.spec.ts` |

## Owner

| ID | Story | Acceptance criteria | Spec |
|---|---|---|---|
| O1 | I sign in and out safely | Wrong password is generic; open redirect ignored; HttpOnly cookies; logout clears | `dashboard.spec.ts`, `auth-cookies.spec.ts` |
| O2 | I see and run the calendar | Status change persists; keyboard operable dialog; conflicting reschedule shows a friendly message | `dashboard.spec.ts` |
| O3 | I manage providers (hours, time off) | Create, split shifts, day off, invalid hours rejected; detail page `providers/[id]` in en and ar at phone width | `management.spec.ts`, `dashboard-journeys.spec.ts` |
| O4 | I manage services | New, edit, validation, deactivate and reactivate; public page follows | `management.spec.ts` |
| O5 | I look up customers | Search, history, hostile names as text, token never shown; `customers/[id]` en/ar/phone; unknown or foreign id never opens | `management.spec.ts`, `dashboard-journeys.spec.ts` |
| O6 | I see revenue | Empty state; only paid payments summed; ar numbers; no overflow on a phone | `dashboard-journeys.spec.ts`, `dashboard.spec.ts` |
| O7 | I edit settings | Demo business: identity, region, brand locked; deposit saves. Own business: everything editable, invalid logo refused | `management.spec.ts`, `demo-visitors.spec.ts` |
| O8 | I curate the assistant's knowledge | FAQ chunks with embeddings, failed embedding kept for retry, PDF upload (fake PDF and scan refused), hostile titles as text, seeded docs locked in the demo | `knowledge.spec.ts`, `demo-visitors.spec.ts` |
| O9 | I read assistant conversations | List and thread, voice marker, link to the booked appointment | `knowledge.spec.ts`, `voice.spec.ts` |
| O10 | I see reminder counts | Today's counts for owner and receptionist, hidden from provider | `reminders.spec.ts` |

## Receptionist

| ID | Story | Acceptance criteria | Spec |
|---|---|---|---|
| R1 | I run the day-to-day schedule | Calendar, reschedule with conflict message, customers, conversations | `dashboard.spec.ts`, `dashboard-journeys.spec.ts` |
| R2 | I cannot see money or admin | No Revenue link; revenue, settings, services/new, providers/new bounce to overview; knowledge 404; upload API 403; catalogue is read only | `dashboard.spec.ts`, `management.spec.ts`, `knowledge.spec.ts`, `dashboard-journeys.spec.ts` |

## Provider (local doctor login)

| ID | Story | Acceptance criteria | Spec |
|---|---|---|---|
| P1 | I see only my own schedule and patients | Other doctor's column, appointments and customers are not listed or openable even by URL | `dashboard.spec.ts`, `management.spec.ts` |
| P2 | I can only mark my own appointments done or no-show | Other statuses and other doctors' rows refused | `dashboard.spec.ts` |
| P3 | I have no admin or money | No revenue, settings, services, conversations, knowledge; upload API 403; a customer of another business is not reachable | `management.spec.ts`, `knowledge.spec.ts`, `dashboard-journeys.spec.ts` |

## Attacker

| ID | Story | Acceptance criteria | Spec |
|---|---|---|---|
| A1 | Forged or replayed payment webhooks | Missing, wrong and near-miss secret 401 with no change; malformed 400; oversize 413; GET 405; valid event confirms once, replay idempotent; wrong amount never confirms (refund_due); failed event keeps pending; unknown reference acknowledged | `webhook-moyasar.spec.ts`, `payments.spec.ts` |
| A2 | Guessing links and tokens | Pay and patient URLs: wrong clinic, case change, truncation, row ids are a bare 404; forged `?status=paid` ignored | `payments.spec.ts`, `reminders.spec.ts`, `my-token.spec.ts` |
| A3 | Cron abuse | 401 without or with a wrong secret and nothing is sent | `reminders.spec.ts` |
| A4 | Demo abuse | One visitor's logout or password change does not affect another; fixed demo users immutable; seeded rows locked | `demo-visitors.spec.ts` |
| A5 | Browser-level attacks | Security headers, CSP clean on public, chat and dashboard pages; no Referer or caching on token pages; no field values in the URL before hydration | `security-headers.spec.ts`, `motion.spec.ts`, `no-js-forms.spec.ts`, `auth-cookies.spec.ts` |
| A6 | Tampered booking input | Past, outside-hours, over-90-day and malformed times are rejected server-side | `booking-invalid.spec.ts` |

## Cross-cutting

Performance (CLS, INP, JS budget) is in `motion-perf.spec.ts`; reduced motion and view transitions in `motion.spec.ts`.
