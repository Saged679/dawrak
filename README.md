# Dawrak (دورك)

Dawrak is an Arabic-first, multi-tenant booking system for clinics and salons. Each business gets a public booking page, a dashboard for its staff, and an AI assistant that talks to customers in chat (text or voice notes) and books real appointments through the same database functions the booking page uses.

It is a portfolio project built to run entirely on free tiers. Arabic (right-to-left) is the primary language; English is fully supported.

## What it does

- **Public booking page** per business (`/ar/c/<slug>`, `/en/c/<slug>`): pick a service, a provider, a free slot, enter name and phone.
- **Chat assistant** on that page. It has tools to list services and providers, check real availability, create, cancel and reschedule bookings, and search the business knowledge base. It asks for an explicit confirmation before it books, cancels or moves anything.
- **Voice notes**: the customer records up to 25 seconds in the chat widget; the audio is sent to Gemini together with the conversation. Only a placeholder such as "[voice note, 7 s]" is stored, not the audio.
- **Knowledge base**: the owner adds FAQs, free text or PDFs (text is extracted on the server, split into chunks, embedded with Gemini and stored with pgvector). The assistant answers business questions from those chunks.
- **Dashboard** with three roles: owner (everything), receptionist (everything except revenue, settings, knowledge base and catalogue editing), provider (own appointments and the customers on them). Pages: overview, calendar, customers, services, providers (with working hours and time off), knowledge, conversations, revenue, settings (name, logo, brand colour, timezone, currency, deposit rule).
- **Deposits** through Moyasar (hosted invoice page, test mode), behind a `PaymentProvider` interface. An unpaid booking is held for 15 minutes. Webhooks are authenticated and the payment is re-fetched from the provider before anything is confirmed.
- **Reminders and patient page**: confirmed appointments get 24h and 2h reminder emails with a magic link to a page where the customer can cancel or reschedule (until 2 hours before the start). A customer can also ask for a fresh link.
- **Hijri dates** shown next to Gregorian dates (Umm al-Qura calendar via `Intl`).
- **Demo mode** with one-click sign-in as clinic owner, clinic receptionist or salon owner. Every visitor gets their own temporary account (deleted after 24 hours), a per-visitor demo mailbox instead of real email, a read-mostly demo business (seeded services, doctors, hours and knowledge are locked), abuse caps on demo data, and a daily reset.

## What is and is not verified

Verified by automated tests and by running the app against a local Supabase stack: booking, the double-booking protection, row-level security and grants, the payment settlement logic, the webhook handler (with the fake provider and unit tests), the reminder dispatcher and demo mailbox, the dashboard roles, PDF upload handling, voice-note recording UI, security headers.

Not verified, because it needs keys or accounts that were never used:

- **Live Gemini**: the chat, voice and embedding calls were exercised with mocked models and an offline mock embedder in tests. A real `GOOGLE_GENERATIVE_AI_API_KEY` was not used in automated runs (unverified end to end).
- **Real Moyasar**: the adapter was written from the public docs. Invoice creation, the real webhook and the real payment fetch were never run against Moyasar. The code notes two doubts: the invoice response schema (it reads `id` and `url`) and whether webhooks carry metadata (it does not rely on that).
- **Real email**: the Resend adapter was never run with a real key. Demo businesses never send real mail, they write to the demo mailbox.
- **WhatsApp** is a documented stub (`src/lib/channels/whatsapp.ts`). No route imports it. It is not connected.
- Hijri dates come from the browser/Node `Intl` Umm al-Qura calendar; they were not checked against an official calendar.
- The hosted deployment steps below follow the code and the Supabase/Vercel docs but were not run on a hosted project by the author of this document (unverified).

## Tech stack

Next.js 16 (App Router, TypeScript), React 19, Supabase (Postgres 17, RLS, pgvector, pg_cron, Auth, Storage config), Vercel AI SDK with Gemini (`gemini-2.5-flash` by default, `gemini-embedding-001` at 768 dimensions), next-intl, Tailwind CSS 4, Vitest, Playwright, pgTAP. Fonts: Readex Pro and IBM Plex Sans Arabic.

## Repository layout

```
src/app/[locale]/       pages: home, c/<slug> (booking, patient page, pay), dashboard, demo, login
src/app/api/            chat, cron/reminders, webhooks/moyasar, dashboard/knowledge/pdf
src/lib/agent/          channel-agnostic assistant core (prompt, tools, rate limits)
src/lib/channels/       web adapter, WhatsApp stub
src/lib/payments/       PaymentProvider interface, Moyasar and fake providers
src/lib/reminders/      dispatcher and retry policy
src/lib/mail/           mail providers (Resend, demo outbox)
src/lib/security/       security headers
supabase/migrations/    schema, RLS, functions, grants, cron jobs
supabase/tests/         pgTAP tests
supabase/seed.sql       local demo users and demo data
e2e/                    Playwright tests
tests/                  Vitest tests (also src/**/*.test.ts)
scripts/race-test.mjs   concurrent double-booking check
design/                 design options; option 04 is the chosen one
docs/                   architecture, deploy checklist, portfolio text, video script
```

## Local setup

Requirements: Node.js 20.9 or newer (required by Next.js 16; `package.json` has no `engines` field), npm, Docker (for the local Supabase stack).

1. Install dependencies: `npm ci`
2. Start Supabase: `npx supabase start`. Ports are set in `supabase/config.toml`: API 55321, Postgres 55322, Studio 55323, local mail inbox 55324. Migrations and `supabase/seed.sql` run automatically (`npx supabase db reset` re-runs them).
3. Copy `.env.example` to `.env.local` and fill in the values. Take the URL and keys from the output of `npx supabase status`: `NEXT_PUBLIC_SUPABASE_URL` is `http://127.0.0.1:55321`.
   - Needed: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SITE_URL`.
   - Needed for the assistant and the knowledge base: `GOOGLE_GENERATIVE_AI_API_KEY` (free key from Google AI Studio). Without it the chat API answers "not configured".
   - Demo: `DEMO_MODE=true`. There is no demo password in the app: each visitor gets a random one, server-side. `DEMO_PASSWORD` exists only for the Playwright specs that sign in as the fixed seeded users (e.g. the provider role) on a local stack.
   - Optional: `CRON_SECRET` (16+ characters, needed to call the reminders endpoint), `GEMINI_MODEL`, `PAYMENT_PROVIDER=fake` (local demo deposits without Moyasar; only for demo businesses), `MOYASAR_SECRET_KEY` and `MOYASAR_WEBHOOK_SECRET`, `MAIL_PROVIDER=resend` with `RESEND_API_KEY` and `MAIL_FROM` (real businesses only), `FAKE_WEBHOOK_SECRET`, `ALLOW_FAKE_PAYMENTS`.
4. Demo accounts: `supabase/seed.sql` creates six users and the demo data. Password for all of them locally is the value in the seed (see the comment at the top of `supabase/seed.sql`; `.env.example` shows the same default in `DEMO_PASSWORD`). These fixed users are for local development and e2e only; the `/demo` page does not use them (it creates a temporary user per visitor). The e2e specs sign in as `clinic-doctor@example.com` for the provider role. The seed also creates `salon-reception@example.com` and `salon-stylist@example.com`. The two demo businesses are `demo-clinic` (deposit on, 50 SAR) and `demo-salon` (no deposit).
5. Run: `npm run dev`, then open `http://localhost:3000/ar/demo`.

## Checks and tests

| What | Command |
|---|---|
| Lint | `npm run lint` |
| Type check | `npm run typecheck` |
| Unit and integration tests (Vitest, mocked database and model) | `npm test` |
| Browser tests (Playwright, desktop and mobile; builds and starts the app; needs the local Supabase stack) | `npm run test:e2e` |
| Database tests (pgTAP: RLS, grants, booking, payments, reminders, demo protection) | `npx supabase test db` |
| Concurrency check for double booking (local stack only, refuses other URLs) | `node scripts/race-test.mjs [rounds]` |

The Playwright config sets its own demo, fake-payment and cron env vars for the server it starts.

## Free-tier deployment

See `docs/DEPLOY_CHECKLIST.md` for the ordered checklist. Summary:

1. **Supabase free project.** Push the migrations (`npx supabase link`, `npx supabase db push`). Do not run `seed.sql` on the hosted project. In Dashboard, Database, Extensions, enable `pg_cron` (the migrations schedule two jobs and only print a notice if it is missing). In Authentication, turn off "Allow new users to sign up".
2. **Demo data.** Run `select public.reset_demo();` with the service role to create the demo businesses and seed data. No shared demo login is needed: visitors are created on demand (see Demo security below). The six fixed users are optional and, if you create them, get random passwords from `reset_demo()`.
3. **Vercel Hobby.** Import the repository and set the environment variables listed in the checklist. `DEMO_MODE=true` is all the demo needs (plus the service-role key); there is no demo password.
4. **GitHub Actions secrets** for `.github/workflows/reminders.yml`: `APP_URL` (no trailing slash) and `CRON_SECRET` (same as on Vercel).
5. **Moyasar test mode.** Use an `sk_test_` key. In the Moyasar dashboard add a webhook to `<site>/api/webhooks/moyasar` for payment events and enter the same random string as `MOYASAR_WEBHOOK_SECRET` in the Secret Token field. Moyasar then sends a `webhook_verification` event; the app logs the 6-digit code (log line `payment_webhook_verification_code`), which you enter in Moyasar. The fake payment provider is refused on a Vercel production deployment, so a hosted demo with deposits needs Moyasar test mode.
6. **Resend free plan**: 100 mails a day, 3000 a month. Without a verified domain Resend only delivers to the account owner's address.

## Demo security (per-visitor accounts, read-mostly business)

- **No shared login.** `enterDemo` (the `/demo` server action) rate limits, then creates a NEW auth user through the Auth Admin API (`app_metadata.demo_visitor`, random `v-<hex>@demo.dawrak.invalid` address, 32-byte random password generated server-side, used once to sign in on the server and never shown or stored), calls `register_demo_user` and, on any failure, deletes the user again. A visitor who already holds a session for the same persona is just redirected. Sign-out of an old visitor session is `scope: "local"` only. A visitor can change their own throw-away account's password or log out globally; that cannot reach anyone else's session.
- **Personas:** clinic owner, clinic receptionist, salon owner. The provider (doctor) role cannot be per visitor (it is tied to one seeded provider row), so it is not offered on `/demo` and is covered by e2e specs that use the fixed seeded user locally.
- **Expiry:** visitors live 24 hours. `purge_expired_demo_users()` runs from pg_cron every 15 minutes; `/api/cron/reminders` also deletes expired visitors through the Admin API (backup if SQL deletion from `auth.users` is not allowed on the hosted project). Caps: 300 visitors in total, 150 per demo business; over the cap the page says the demo is busy.
- **Read-mostly demo business:** signed-in demo users cannot update or delete seeded services, providers, provider links, working hours, time off or knowledge rows (database triggers, error `demo_readonly`); rows they create themselves stay editable. Inserts within the caps, appointment status changes and rescheduling still work. The dashboard shows a "locked in the demo business" banner and disables those controls; the database is the real gate.
- **Demo links:** in demo businesses "send me my link" only issues a link to the visitor session that created the customer, and a still-valid link is reused rather than rotated.
- **Auth cookies** are HttpOnly, SameSite=Lax, Secure in production, 7 days (24 hours when created by the demo entry). Nothing in the browser reads them.
- **Client IP:** off Vercel every client shares one rate-limit bucket unless `TRUSTED_PROXY_HEADER` names a header your own reverse proxy sets (right-most entry used). Production logs one warning when neither applies.
- **Not verified on a hosted Supabase project:** that GoTrue accepts the `.invalid` domain there, that the Admin API and `register_demo_user` work with the hosted service-role key, that pg_cron deletion from `auth.users` is permitted, that the auth-schema guard triggers of migration 19 get created by `db push`, and the Admin API limits of the free tier under real traffic. Everything above was run against the local stack only.

## Known limitations

- Vercel Hobby cron runs at most once a day, so `vercel.json` only adds a daily backup call. The 30-minute schedule comes from GitHub Actions; GitHub may delay runs and pauses scheduled workflows after 60 days without repository activity.
- Gemini free tier has daily and per-minute quotas. The app limits chat per IP (20 messages per 10 minutes), per business (300 per day), voice notes separately (6 per 10 minutes per IP, 60 per day per business), and knowledge-base writes. Hitting a Google quota returns an error to the visitor (behaviour under real quota errors unverified).
- Real businesses cannot send email until `MAIL_PROVIDER=resend`, a key and, for anyone other than the Resend account owner, a verified domain are set. Otherwise reminders retry and then are marked failed.
- Bookings made through the chat assistant do not send a confirmation email (only the web form does); reminders still apply.
- Demo mailbox: seeded demo appointments get no reminders, and neither do demo appointments booked through the chat assistant (they are not tied to the visitor's session, `src/app/[locale]/c/[slug]/actions.ts` only attaches web-form bookings). Only demo appointments booked through the web form produce mails, in that visitor's demo mailbox.
- The content security policy allows `'unsafe-inline'` for scripts. Next.js bootstrap scripts are inline, and a per-request nonce would force every page to render dynamically, including the statically generated home pages. Experimental subresource integrity did not cover the inline scripts. No `unsafe-eval` in production. A nonce is the documented upgrade path (`src/lib/security/headers.ts`).
- Rate limiting keys on the client IP header; its accuracy depends on the hosting proxy (see `src/lib/db/client-ip.ts`, not reviewed again here).
- The "user_confirmed" check on booking tools is a flag the model sets, plus the prompt rule. It is not a cryptographic proof that the customer said yes.
- Refunds are not automated: a payment that arrives after the slot is gone or the booking was cancelled is marked `refund_due` for a person to handle.

## License and data

All demo data is fictional. Do not enter real personal data in the demo.

---

# دورك

«دورك» نظام حجز مواعيد للعيادات والصالونات، عربي أولًا ومتعدد المنشآت. لكل منشأة صفحة حجز عامة، ولوحة تحكم لفريقها، ومساعد ذكي يحادث العملاء كتابةً أو برسائل صوتية ويحجز لهم مواعيد فعلية في قاعدة البيانات نفسها التي تعتمد عليها صفحة الحجز.

المشروع نموذج لأعمالي (Portfolio)، مبني ليعمل بالكامل على الباقات المجانية. العربية (من اليمين إلى اليسار) هي اللغة الأساسية، والإنجليزية مدعومة بالكامل.

## ما يقدمه

- **صفحة حجز عامة** لكل منشأة: اختيار الخدمة والمختص والموعد المتاح، ثم الاسم ورقم الجوال.
- **مساعد محادثة** في الصفحة نفسها. يعرض الخدمات والمختصين، ويفحص المواعيد الفعلية، وينشئ الحجز أو يلغيه أو يغيّر موعده، ويبحث في قاعدة معرفة المنشأة. ولا ينفذ الحجز أو الإلغاء أو التعديل إلا بعد تأكيد صريح من العميل.
- **رسائل صوتية**: يسجل العميل حتى 25 ثانية داخل المحادثة، ويُرسل الصوت إلى Gemini مع سياق المحادثة. لا يُحفظ الصوت، بل علامة نصية فقط مثل «[voice note, 7 s]».
- **قاعدة المعرفة**: يضيف المالك أسئلة شائعة أو نصًا أو ملفات PDF، فيُستخرج النص ويُقسّم ويُحوَّل إلى متجهات (pgvector) ويعتمد عليها المساعد في الإجابة.
- **لوحة تحكم بثلاثة أدوار**: المالك (كل الصلاحيات)، الاستقبال (كل شيء عدا الإيرادات والإعدادات وقاعدة المعرفة وتعديل الخدمات والمختصين)، والمختص (مواعيده وعملاؤه فقط).
- **العربون** عبر مُيسّر (Moyasar) في وضع الاختبار، من خلال واجهة موحدة لمزودي الدفع. الحجز غير المدفوع يُحجز لمدة 15 دقيقة، ولا يُؤكَّد الدفع إلا بعد التحقق من المزود نفسه.
- **التذكيرات وصفحة المريض**: تذكير قبل 24 ساعة وقبل ساعتين عبر البريد، مع رابط سحري لصفحة يلغي منها العميل موعده أو يغيّره حتى ساعتين قبل الموعد.
- **التاريخ الهجري** بجانب الميلادي (تقويم أم القرى عبر `Intl`).
- **وضع العرض التجريبي**: دخول بنقرة كمالك عيادة أو موظف استقبال أو طبيب أو مالكة صالون، وصندوق بريد تجريبي خاص بكل زائر بدل البريد الحقيقي، وحدود لمنع إساءة الاستخدام، وإعادة ضبط يومية.

## ما تم التحقق منه وما لم يتم

تم التحقق عبر الاختبارات الآلية والتشغيل على Supabase محلي من: الحجز، ومنع الحجز المزدوج، وصلاحيات قاعدة البيانات، ومنطق تسوية الدفع، ومعالجة الـ webhook (بالمزود التجريبي واختبارات الوحدة)، والتذكيرات وصندوق البريد التجريبي، وأدوار لوحة التحكم، ورفع ملفات PDF، وواجهة التسجيل الصوتي، وترويسات الأمان.

لم يتم التحقق منه لأنه يحتاج مفاتيح أو حسابات لم تُستخدم:

- **Gemini الحقيقي**: جُرّبت المحادثة والصوت والتضمين بنماذج وهمية في الاختبارات، ولم يُستخدم مفتاح حقيقي في الاختبارات الآلية.
- **مُيسّر الحقيقي**: كُتب المحوّل من وثائق مُيسّر العامة، ولم يُجرَّب إنشاء الفاتورة ولا الـ webhook ولا جلب الدفعة على حساب حقيقي.
- **البريد الحقيقي (Resend)**: لم يُجرَّب بمفتاح حقيقي. المنشآت التجريبية لا ترسل بريدًا حقيقيًا أبدًا.
- **واتساب**: هيكل موثّق فقط (`src/lib/channels/whatsapp.ts`) وغير موصول بأي مسار.
- التاريخ الهجري من `Intl` ولم يُقارن بتقويم رسمي.

## التقنيات

Next.js 16 وReact 19 وSupabase (Postgres وRLS وpgvector وpg_cron) وVercel AI SDK مع Gemini وnext-intl وTailwind وVitest وPlaywright وpgTAP.

## التشغيل محليًا

1. تأكد من Node.js 20.9 أو أحدث، وDocker.
2. `npm ci`
3. `npx supabase start` (المنافذ في `supabase/config.toml`: الواجهة 55321 وقاعدة البيانات 55322).
4. انسخ `.env.example` إلى `.env.local` واملأه من ناتج `npx supabase status`. الضروري: روابط ومفاتيح Supabase و`NEXT_PUBLIC_SITE_URL`. للمساعد وقاعدة المعرفة: `GOOGLE_GENERATIVE_AI_API_KEY`. الباقي اختياري (مُيسّر، Resend، `CRON_SECRET`).
5. الحسابات التجريبية تُنشأ من `supabase/seed.sql` (مثل `clinic-owner@example.com`)، وكلمة المرور مذكورة في أعلى الملف وفي `.env.example`.
6. `npm run dev` ثم افتح `http://localhost:3000/ar/demo`.

## الفحوصات

`npm run lint` و`npm run typecheck` و`npm test` (Vitest) و`npm run test:e2e` (Playwright، يحتاج Supabase المحلي) و`npx supabase test db` (pgTAP) و`node scripts/race-test.mjs` (اختبار الحجز المتزامن، محلي فقط).

## النشر المجاني

التفاصيل في `docs/DEPLOY_CHECKLIST.md`: مشروع Supabase مجاني (فعّل pg_cron وعطّل التسجيل الجديد ثم نفّذ `reset_demo()`؛ لا حاجة لمستخدمين تجريبيين ثابتين، إذ يُنشأ حساب مؤقت لكل زائر)، وVercel Hobby، وأسرار GitHub (`APP_URL` و`CRON_SECRET`) للتذكيرات، ومفتاح مُيسّر التجريبي مع عنوان الـ webhook `<الموقع>/api/webhooks/moyasar` والرمز السري.

## قيود معروفة

- مهام Vercel Hobby المجدولة تعمل مرة واحدة يوميًا، لذلك تُشغَّل التذكيرات كل 30 دقيقة من GitHub Actions.
- لـ Gemini المجاني حصص يومية، وللتطبيق حدود على المحادثة والرسائل الصوتية.
- Resend المجاني بلا نطاق موثّق يرسل فقط إلى بريد صاحب الحساب.
- سياسة أمان المحتوى (CSP) تسمح بـ `unsafe-inline` للسكربتات، لأن سكربتات Next.js التمهيدية مضمّنة، والبديل (nonce) يُجبر كل الصفحات على العرض الديناميكي.
- المبالغ المدفوعة بعد ضياع الموعد تُوسَم «مستردة مستحقة» وتُعالج يدويًا.
- كل البيانات التجريبية وهمية، فلا تُدخل بيانات حقيقية في العرض التجريبي.
