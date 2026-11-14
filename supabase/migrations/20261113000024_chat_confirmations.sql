-- Chat two-phase confirmation (server-side enforcement of "the visitor confirmed").
--
--  * chat_confirmation_uses: one row per confirmation token that was spent. The PRIMARY KEY
--    (conversation_id, jti) makes "single use" atomic: two concurrent executes with the same token race on
--    the INSERT and exactly one wins (the other gets SQLSTATE 23505). A failed action releases its row.
--    Chosen over message metadata because messages are append-only history and have no uniqueness or
--    compare-and-set; chosen over a jsonb column on conversations because a read-modify-write there is racy.
--  * chat_agent_state: the compact server state the next turn needs (last availability result, pending
--    confirmation incl. its token), so the model does not have to re-call tools and the token survives
--    between turns without tool results being persisted as visitor-facing messages.
--
-- Both are internal: RLS enabled AND forced, no policies, no access for anon/authenticated, service_role only
-- (the chat route uses the service-role client). Rows go away with their conversation (cascade).
create table if not exists public.chat_confirmation_uses (
  tenant_id       uuid not null,
  conversation_id uuid not null,
  jti             text not null check (length(jti) between 8 and 64),
  action          text not null check (action in ('create_booking', 'reschedule_booking', 'cancel_booking')),
  used_at         timestamptz not null default now(),
  primary key (conversation_id, jti),
  foreign key (conversation_id, tenant_id) references public.conversations (id, tenant_id) on delete cascade
);
create index if not exists chat_confirmation_uses_tenant_idx on public.chat_confirmation_uses (tenant_id, used_at);

create table if not exists public.chat_agent_state (
  conversation_id uuid primary key,
  tenant_id       uuid not null,
  state           jsonb not null default '{}'::jsonb check (pg_column_size(state) < 20000),
  updated_at      timestamptz not null default now(),
  foreign key (conversation_id, tenant_id) references public.conversations (id, tenant_id) on delete cascade
);

alter table public.chat_confirmation_uses enable row level security;
alter table public.chat_confirmation_uses force row level security;
alter table public.chat_agent_state enable row level security;
alter table public.chat_agent_state force row level security;

revoke all on public.chat_confirmation_uses, public.chat_agent_state from public, anon, authenticated, service_role;
grant select, insert, delete on public.chat_confirmation_uses to service_role;
grant select, insert, update, delete on public.chat_agent_state to service_role;
