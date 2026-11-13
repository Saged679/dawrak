# دورك (Dawrak)

Arabic/English multi-tenant booking SaaS for clinics and salons, with an AI assistant that books appointments. Built as a Mostaqel portfolio piece. Architecture: `docs/ARCHITECTURE.md`; setup and deployment: `README.md` and `docs/DEPLOY_CHECKLIST.md`.

## Hard rules
- **Everything must be free.** No paid services, plans, domains or APIs. Free tiers only: Vercel Hobby, Supabase free, Gemini API free tier, Moyasar test mode, Resend free, Google Fonts. If something needs payment, stop and report it instead of using it.
- **Claude is the orchestrator.** Work is done by the role agents in `.claude/agents/`. The main session briefs them and reads their reports.
- Arabic first (RTL), English second.
- **Chosen design: option 4, "chat-first" (`design/options/04-mohadatha/`).** Tokens, fonts (Readex Pro, IBM Plex Sans Arabic) and the reasoning are in its `NOTES.md`; the HTML/CSS there is the visual reference. The other four options are archived references only.

## Stack
Next.js 16 (App Router, TS), Supabase (Postgres, RLS, pgvector, Storage), Vercel AI SDK + Gemini, Tailwind + shadcn, next-intl, Vitest, Playwright.

## Conventions
- Every table has `tenant_id`; RLS enforces isolation through `memberships`.
- The agent core has no channel-specific code; channels live in `src/lib/channels/`.
- Payments go through the `PaymentProvider` interface in `src/lib/payments/`.
- Agents report back briefly: what changed, files touched, what is unverified.
