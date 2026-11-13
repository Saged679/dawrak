-- Per-visitor demo users (round 3). The public demo no longer shares fixed logins: the app creates one
-- temporary auth user per visitor (GoTrue Admin API, service role) and then calls register_demo_user().
--
--  1. demo_users registry (forced RLS, service_role only).
--  2. register_demo_user(): validates tenant/role, enforces global + per-tenant caps, creates the membership.
--     The membership freeze trigger (trg_demo_memberships_readonly) only blocks current_user in
--     ('authenticated','anon'); this function is SECURITY DEFINER owned by postgres, so the insert is allowed
--     without touching the dawrak.seeding flag (which would also lift the row caps).
--  3. purge_expired_demo_users(): deletes expired visitors straight from auth.users (identities, sessions,
--     refresh_tokens, mfa_* cascade through their FKs; the registry row and memberships cascade too).
--     pg_cron every 15 minutes.
--  4. reset_demo(): purges all visitors, re-seeds, and (unless demo_config has allow_fixed_demo_login = 'on', which
--     only supabase/seed.sql sets, i.e. local/e2e) replaces the six fixed demo users' passwords with random ones.

-- =====================================================================================
-- 1. registry
-- =====================================================================================
create table if not exists public.demo_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  role       text not null check (role in ('owner','receptionist')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);
create index if not exists demo_users_expires_idx on public.demo_users (expires_at);
create index if not exists demo_users_tenant_idx on public.demo_users (tenant_id);

alter table public.demo_users enable row level security;
alter table public.demo_users force row level security;
revoke all on public.demo_users from public, anon, authenticated;
grant select, insert, update, delete on public.demo_users to service_role;
-- no policies: authenticated/anon see nothing even if a grant were added by mistake

-- local switch read by reset_demo(); only supabase/seed.sql (never run on the hosted project) writes to it
create table if not exists public.demo_config (key text primary key, value text not null);
alter table public.demo_config enable row level security;
alter table public.demo_config force row level security;
revoke all on public.demo_config from public, anon, authenticated;

-- =====================================================================================
-- 2. register_demo_user
-- =====================================================================================
-- Errors (all P0001 unless noted): not_demo, invalid_role, protected_user (a fixed seeded demo user),
-- already_registered, user_not_found (no such auth user, 23503), demo_users_limit (54000, global cap 300),
-- demo_tenant_users_limit (54000, 150 per tenant).
create or replace function public.register_demo_user(p_user_id uuid, p_tenant_id uuid, p_role text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_row public.demo_users;
begin
  if p_user_id is null or p_tenant_id is null then raise exception 'invalid_arguments'; end if;
  if not public._tenant_is_demo(p_tenant_id) then raise exception 'not_demo'; end if;
  if p_role is null or p_role not in ('owner','receptionist') then raise exception 'invalid_role'; end if;
  if p_user_id::text ~ '^a0000000-0000-4000-8000-00000000000[0-9]$' then raise exception 'protected_user'; end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'user_not_found' using errcode = '23503';
  end if;

  -- serialise registrations so the caps cannot be overshot by concurrent calls
  perform pg_advisory_xact_lock(hashtext('dawrak.register_demo_user'));
  if exists (select 1 from public.demo_users where user_id = p_user_id) then raise exception 'already_registered'; end if;
  if (select count(*) from public.demo_users) >= 300 then
    raise exception 'demo_users_limit' using errcode = '54000';
  end if;
  if (select count(*) from public.demo_users where tenant_id = p_tenant_id) >= 150 then
    raise exception 'demo_tenant_users_limit' using errcode = '54000';
  end if;

  insert into public.demo_users (user_id, tenant_id, role) values (p_user_id, p_tenant_id, p_role)
  returning * into v_row;
  insert into public.memberships (user_id, tenant_id, role) values (p_user_id, p_tenant_id, p_role)
  on conflict (user_id, tenant_id) do update set role = excluded.role;

  return jsonb_build_object('user_id', v_row.user_id, 'tenant_id', v_row.tenant_id,
                            'role', v_row.role, 'expires_at', v_row.expires_at);
end $$;

-- =====================================================================================
-- 3. purge_expired_demo_users
-- =====================================================================================
-- Deletes up to 500 expired visitors per call (returns how many) plus orphans: auth users the app flagged
-- with app_metadata.demo_visitor = true that never got registered within an hour (crash between createUser
-- and register_demo_user). The six fixed users are never touched.
create or replace function public.purge_expired_demo_users()
returns int
language plpgsql volatile security definer
set search_path = ''
as $$
declare v_n int; v_o int;
begin
  delete from auth.users u
   where u.id in (select d.user_id from public.demo_users d where d.expires_at <= now()
                   order by d.expires_at limit 500)
     and u.id::text !~ '^a0000000-0000-4000-8000-00000000000[0-9]$';
  get diagnostics v_n = row_count;

  delete from auth.users u
   where coalesce(u.raw_app_meta_data ->> 'demo_visitor', '') = 'true'
     and u.created_at < now() - interval '1 hour'
     and not exists (select 1 from public.demo_users d where d.user_id = u.id)
     and u.id::text !~ '^a0000000-0000-4000-8000-00000000000[0-9]$';
  get diagnostics v_o = row_count;

  -- registry rows whose user vanished are already gone (FK cascade); stale rows cannot exist.
  return v_n + v_o;
end $$;

revoke all on function public.register_demo_user(uuid, uuid, text), public.purge_expired_demo_users()
  from public, anon, authenticated;
grant execute on function public.register_demo_user(uuid, uuid, text), public.purge_expired_demo_users()
  to service_role;
comment on function public.register_demo_user(uuid, uuid, text) is
  'service_role only. Registers an already-created auth user as a temporary demo visitor and creates its membership (owner|receptionist). Caps: 300 global, 150 per tenant.';
comment on function public.purge_expired_demo_users() is
  'service_role / pg_cron every 15 min. Deletes expired demo visitors from auth.users (everything cascades).';

do $$
begin
  perform cron.schedule('dawrak_purge_demo_users', '*/15 * * * *', 'select public.purge_expired_demo_users()');
exception when others then
  raise notice 'pg_cron not available (%): schedule public.purge_expired_demo_users() externally', sqlerrm;
end $$;

-- =====================================================================================
-- 4. reset_demo
-- =====================================================================================
create or replace function public.reset_demo()
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform set_config('dawrak.seeding', 'on', true);
  delete from public.demo_outbox;

  -- every temporary visitor goes (auth rows cascade to identities, sessions, refresh tokens, memberships)
  delete from auth.users u
   where u.id in (select d.user_id from public.demo_users d)
     and u.id::text !~ '^a0000000-0000-4000-8000-00000000000[0-9]$';
  delete from auth.users u
   where coalesce(u.raw_app_meta_data ->> 'demo_visitor', '') = 'true'
     and u.id::text !~ '^a0000000-0000-4000-8000-00000000000[0-9]$';

  delete from public.tenants
   where is_demo
      or id in ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');
  perform public.seed_demo();

  -- The fixed shared demo logins must not be usable on a public project: random passwords, unless this
  -- database opted in (supabase/seed.sql sets demo_config.allow_fixed_demo_login for local dev and e2e).
  if not exists (select 1 from public.demo_config where key = 'allow_fixed_demo_login' and value = 'on') then
    update auth.users
       set encrypted_password = extensions.crypt(encode(extensions.gen_random_bytes(24), 'hex'), extensions.gen_salt('bf'))
     where id::text ~ '^a0000000-0000-4000-8000-00000000000[1-6]$';
  end if;
  perform set_config('dawrak.seeding', 'off', true);
end $$;
revoke all on function public.reset_demo() from public, anon, authenticated;
grant execute on function public.reset_demo() to service_role;
