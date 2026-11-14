# Free deployment checklist

Follow in order. Everything uses free tiers. Steps on hosted dashboards were written from the code and from general knowledge of those products, and were not run by the author of this document (unverified); menu names may differ.

## 1. Accounts needed
- [ ] GitHub (repository and Actions)
- [ ] Supabase (free project)
- [ ] Vercel (Hobby plan)
- [ ] Google AI Studio (free Gemini API key)
- [ ] Moyasar (test mode account, `sk_test_` key)
- [ ] Resend (free plan), only if real businesses must receive email

## 2. Supabase
- [ ] Create a free project; note the project URL, the anon key and the service-role key.
- [ ] Link and push migrations from your machine: `npx supabase login`, `npx supabase link --project-ref <ref>`, `npx supabase db push`. Do not run `supabase/seed.sql` on the hosted project.
- [ ] Database, Extensions: enable `pg_cron`. Then check the jobs exist: `select jobname, schedule from cron.job;` should list `dawrak_expire_pending` (`* * * * *`) and `dawrak_reset_demo` (`0 3 * * *`). If they are missing, re-run the last statements of migrations 10 and 14 (they only print a notice when pg_cron is unavailable).
- [ ] Authentication, sign-in settings: turn off "Allow new users to sign up". (Local config has `enable_signup = false`.)
- [ ] Confirm the auth triggers from migration 19 exist after `db push`: `select tgname from pg_trigger where tgname in ('dawrak_auth_users_guard','dawrak_auth_sessions_guard');` returns both rows (they protect the six fixed users; migrations run as `postgres`, which can create triggers on `auth` tables on a standard project, unverified). If a row is missing, note it as a known gap: the hosted demo does not rely on the fixed users (`reset_demo()` gives them random passwords).
- [ ] No demo users to create and no demo password to choose: the app creates one temporary user per visitor through the Admin API with the service-role key. The six fixed users from `supabase/seed.sql` are optional; do not create them.
- [ ] Run `select public.reset_demo();` with the service role (SQL editor). This creates the demo businesses `demo-clinic` and `demo-salon` and the seed data.
- [ ] Check the demo purge is scheduled: `select jobname, schedule from cron.job;` also lists `dawrak_purge_demo_users` (`*/15 * * * *`), and `select public.purge_expired_demo_users();` runs without a permission error. If SQL deletion from `auth.users` is not permitted on the hosted project, the daily Vercel cron and the 30-minute GitHub Action call `/api/cron/reminders`, which deletes expired visitors (ids from `demo_users where expires_at < now()`) through the Admin API instead.
- [ ] Leftover demo users: Dashboard, Authentication, Users, search `demo.dawrak.invalid` and delete them; or run `select public.purge_expired_demo_users();` (expired visitors and unregistered orphans); `select public.reset_demo();` removes ALL visitors and re-seeds the demo businesses.
- [ ] Free-tier note: free Supabase projects pause after a period of inactivity (unverified; check current Supabase terms), so open the demo before showing it.

## 3. Environment variables (Vercel, Settings, Environment Variables)

| Variable | Where to get it | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase, Project settings, API | public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same | public |
| `SUPABASE_SERVICE_ROLE_KEY` | same | secret, server only |
| `NEXT_PUBLIC_SITE_URL` | your Vercel URL, no trailing slash | used in links, cookies (`secure` when https) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google AI Studio | secret; without it chat says "not configured" |
| `GEMINI_MODEL` | optional | primary model, defaults to `gemini-3.5-flash-lite` |
| `GEMINI_FALLBACK_MODELS` | optional, comma-separated | tried in order on quota (429) or 404; free quotas are per model and per day: check https://aistudio.google.com/rate-limit |
| `GEMINI_THINKING` | optional: `minimal`, `low`, `medium`, `high`, `default` | unset = `minimal` on `gemini-3.x-flash-lite`, nothing on other models |
| `CRON_SECRET` | generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | min 16 characters; same value in GitHub secrets |
| `DEMO_MODE` | set `true` for the demo site | exactly `true` |
| `DEMO_PASSWORD`, `DEMO_*_EMAIL` | leave UNSET | not used by the app any more (each visitor gets a random password); local e2e only |
| `TRUSTED_PROXY_HEADER` | leave unset on Vercel | only when self-hosting behind your own reverse proxy |
| `PAYMENT_PROVIDER` | `moyasar` (or leave unset when the key is set) | do NOT use `fake` on Vercel production, it is refused |
| `MOYASAR_SECRET_KEY` | Moyasar dashboard, API keys, `sk_test_...` | secret |
| `MOYASAR_WEBHOOK_SECRET` | a long random string you generate | same string goes in Moyasar as Secret Token |
| `MAIL_PROVIDER` | `resend` only for real businesses | demo businesses always use the demo mailbox |
| `RESEND_API_KEY`, `MAIL_FROM` | Resend | without a verified domain Resend delivers only to the account owner |

Never set `DAWRAK_MOCK_EMBEDDINGS`, `ALLOW_FAKE_PAYMENTS` or `FAKE_WEBHOOK_SECRET` in production.

## 4. Vercel
- [ ] Import the GitHub repository (framework: Next.js). Add the variables above, then deploy.
- [ ] Copy the production URL into `NEXT_PUBLIC_SITE_URL` and redeploy.
- [ ] `vercel.json` adds one daily cron call to `/api/cron/reminders` (Hobby allows daily only). Vercel sends `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is set as an env var (per the code comment in the route; unverified on Vercel).

## 5. GitHub Actions secrets (reminders every 30 minutes)
- [ ] Repository, Settings, Secrets and variables, Actions: add `APP_URL` (production URL, no trailing slash) and `CRON_SECRET` (same value as on Vercel).
- [ ] Run the "reminders" workflow once with "Run workflow". Expected: green run, JSON like `{"ok":true,"claimed":0,...}`.
- [ ] GitHub pauses scheduled workflows after 60 days without repository activity; re-enable or push a commit.

## 6. Moyasar test mode
Until `MOYASAR_SECRET_KEY` is set, a business with deposits enabled (the demo clinic) refuses bookings with the message "Online payment is not available yet for this clinic" (web form and chat); nothing is created and no slot is held. Businesses without a deposit (the demo salon) keep working. This is expected, not an outage.
- [ ] Put the `sk_test_` key in `MOYASAR_SECRET_KEY`.
- [ ] Moyasar dashboard, Webhooks, add: URL `<site>/api/webhooks/moyasar`, Secret Token = your `MOYASAR_WEBHOOK_SECRET`, payment events.
- [ ] Moyasar sends a `webhook_verification` event with a 6-digit code. The app logs it (Vercel, Logs, search `payment_webhook_verification_code`). Enter it in Moyasar to activate the webhook.
- [ ] Test cards: success 4111 1111 1111 1111; failure 4123 1200 0000 0000; any future expiry, any CVC, a name of two words.

## 7. Resend (optional)
- [ ] Free plan: 100 emails a day, 3000 a month. Create an API key. Without a verified domain only your own address receives mail; real customers need a verified domain and a `MAIL_FROM` on it (a domain is not free: if you have none, keep real-business email off).

## 8. Post-deploy smoke test
1. [ ] `<site>/ar` loads, Arabic is right-to-left; `<site>/en` is left-to-right.
2. [ ] `<site>/ar/demo` shows three sign-in buttons (clinic owner, clinic receptionist, salon owner); sign in as the clinic owner and see the calendar with data. Entering in a second browser gives a different user (the user menu shows `v-<hex>@demo.dawrak.invalid`).
3. [ ] Receptionist: no Revenue or Settings links. As a demo owner, Services and Providers show the "locked in the demo business" banner.
4. [ ] `<site>/ar/c/demo-clinic`: book through the form; you land on a payment page.
5. [ ] Pay with the success test card; the appointment becomes confirmed (needs the webhook active).
6. [ ] Open the chat, send a text asking for a clinic service price; the answer matches the demo data (needs the Gemini key).
7. [ ] Send a voice note in a browser with microphone permission.
8. [ ] `<site>/ar/demo/mailbox` shows mails for a web-form booking with an email.
9. [ ] `curl -i -X POST <site>/api/cron/reminders` without the header returns 401; with the Bearer secret returns 200.
10. [ ] Response headers on any page include `Content-Security-Policy`, `X-Frame-Options: DENY` and `Strict-Transport-Security`.
11. [ ] Sign-up is closed: a direct call to the Supabase auth sign-up endpoint with the anon key is refused.

## 9. Double-check in the dashboards
- Supabase: Authentication sign-ups off; `pg_cron` enabled and two jobs listed; no custom RLS changes; service-role key not in any `NEXT_PUBLIC_` variable.
- Vercel: environment variables set for Production; none of `ALLOW_FAKE_PAYMENTS`, `FAKE_WEBHOOK_SECRET`; deployment protection or domain as intended; function logs free of secrets.
- GitHub: both secrets present; the workflow is enabled.
- Moyasar: the webhook shows as verified and the key starts with `sk_test_`.

## 10. Rotating secrets
- `CRON_SECRET`: generate a new value, update Vercel, redeploy, update the GitHub secret.
- `MOYASAR_WEBHOOK_SECRET`: set a new value in Vercel and in the Moyasar webhook's Secret Token at the same time, then redeploy; events between the two changes get 401 and Moyasar retries.
- Moyasar API key: create a new test key, update Vercel, redeploy, revoke the old key.
- Supabase service-role or anon key: rotate in Supabase (JWT settings; this changes keys for the whole project), update Vercel and any local `.env.local`, redeploy.
- `GOOGLE_GENERATIVE_AI_API_KEY`, `RESEND_API_KEY`: create a new key, update Vercel, redeploy, delete the old one.
- `DEMO_PASSWORD`: change the password of the six demo users through the Auth Admin API first, then update Vercel and redeploy.
- Customer magic links rotate by themselves each time a link is issued and expire after 30 days.

## Assistant quota and knowledge search (after deploy)

- Free-tier limits are per model and per day (https://aistudio.google.com/rate-limit). When every model in `GEMINI_MODEL` plus `GEMINI_FALLBACK_MODELS` is exhausted, the chat API answers 503 `assistant_quota` (or `assistant_busy` for a per-minute limit) and the widget points visitors to the booking form. Set at least one fallback model before a demo.
- Apply migration `20261113000023` (`reset_demo()` under pg-safeupdate; hosted PostgREST rejected the old unconditional `DELETE`), then call `reset_demo()` through the REST RPC endpoint once and confirm it returns 204.
- Seeded demo knowledge has no embeddings: questions are answered by the lexical fallback immediately, and the 30-minute reminders cron embeds up to 24 missing chunks per run once `GOOGLE_GENERATIVE_AI_API_KEY` is set (check the `reembed` field of the cron response).
- Real-model checks the automated tests cannot cover (they use mock models): a full Arabic booking ending in "ايوه أكد", no booking claim before the tool succeeds, plain-text replies without Markdown, and first-token latency with the chosen model and `GEMINI_THINKING`.
